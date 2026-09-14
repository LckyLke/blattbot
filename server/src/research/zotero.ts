import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DATA_DIR } from "../config.js";
import { importBibtex, readAllBibEntries } from "../citations.js";
import { entryDoi, parseBib } from "../bib.js";
import { saveUpload, contextUploadsDir } from "../context.js";
import { readPaper, titlesSimilar } from "../papers.js";
import { digest, now, updateStore } from "./store.js";

export const zoteroSchema = z.object({
  mode: z.enum(["local", "web"]),
  libraryType: z.enum(["users", "groups"]),
  libraryId: z.string().regex(/^\d+$/),
  apiKey: z.string().max(200).optional(),
});
type ZoteroConfig = z.infer<typeof zoteroSchema>;
const secretPath = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid project id");
  return join(DATA_DIR, "research-secrets", `${id}.json`);
};
function config(id: string): ZoteroConfig {
  return existsSync(secretPath(id))
    ? JSON.parse(readFileSync(secretPath(id), "utf8"))
    : { mode: "local", libraryType: "users", libraryId: "0" };
}
export function publicZotero(id: string) {
  const { apiKey, ...rest } = config(id);
  return { ...rest, hasApiKey: Boolean(apiKey) };
}
export function configureZotero(id: string, input: ZoteroConfig) {
  const next = zoteroSchema.parse(input);
  if (next.apiKey === undefined) next.apiKey = config(id).apiKey;
  if (next.mode === "local") delete next.apiKey;
  mkdirSync(join(DATA_DIR, "research-secrets"), { recursive: true });
  writeFileSync(secretPath(id), JSON.stringify(next), { mode: 0o600 });
  return publicZotero(id);
}
function base(cfg: ZoteroConfig) {
  return `${cfg.mode === "local" ? "http://127.0.0.1:23119/api" : "https://api.zotero.org"}/${cfg.libraryType}/${cfg.libraryId}`;
}
async function request(id: string, path: string): Promise<Response> {
  const cfg = config(id);
  const response = await fetch(base(cfg) + path, {
    headers: {
      "Zotero-API-Version": "3",
      ...(cfg.apiKey ? { "Zotero-API-Key": cfg.apiKey } : {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok && response.status !== 302 && response.status !== 303)
    throw new Error(
      `Zotero returned HTTP ${response.status}. ${cfg.mode === "local" ? "Open Zotero and enable Settings → Advanced → Allow other applications on this computer to communicate with Zotero." : "Check the library ID and read access of the API key."}`,
    );
  return response;
}
export interface ZoteroItem {
  key: string;
  title: string;
  author: string;
  year: string;
  doi?: string;
  version: number;
}
export async function listZotero(id: string, query: string, start = 0) {
  z.number().int().min(0).parse(start);
  const res = await request(
    id,
    `/items/top?format=json&limit=50&start=${start}&q=${encodeURIComponent(z.string().max(1000).parse(query))}`,
  );
  const raw = (await res.json()) as any[];
  const items: ZoteroItem[] = raw
    .filter(
      (item) =>
        !["attachment", "note", "annotation"].includes(item.data?.itemType),
    )
    .map((item) => ({
      key: item.key,
      title: item.data?.title ?? "Untitled",
      author: (item.data?.creators ?? [])
        .map(
          (person: any) =>
            person.name ??
            [person.firstName, person.lastName].filter(Boolean).join(" "),
        )
        .join(", "),
      year: item.data?.date ?? "",
      doi: item.data?.DOI,
      version: item.version,
    }));
  const total = Number(res.headers.get("Total-Results")) || undefined;
  return { items, total, next: raw.length === 50 ? start + 50 : undefined };
}
function saveImportedFile(id: string, name: string, bytes: Buffer) {
  const path = join(contextUploadsDir(id), name);
  if (existsSync(path)) {
    if (readFileSync(path).equals(bytes)) return { name, size: bytes.length };
    name = `${randomUUID().slice(0, 8)}-${name}`;
  }
  return saveUpload(id, name, bytes);
}

export interface ZoteroImport {
  itemKey: string;
  citeKey: string;
  at: string;
  version?: number;
  pdfPath?: string;
  notesPath?: string;
  warnings: string[];
}
export async function importZotero(
  id: string,
  dir: string,
  itemKey: string,
): Promise<ZoteroImport> {
  z.string()
    .regex(/^[A-Z0-9]{8}$/)
    .parse(itemKey);
  const res = await request(id, `/items/${itemKey}?format=bibtex`);
  const bibtex = await res.text();
  const incoming = parseBib(bibtex)[0];
  if (!incoming) throw new Error("Zotero returned no importable BibTeX");
  importBibtex(dir, bibtex);
  const entry = readAllBibEntries(dir).find(
    ({ entry }) =>
      (entryDoi(incoming.fields) &&
        entryDoi(entry.fields) === entryDoi(incoming.fields)) ||
      titlesSimilar(entry.fields.title ?? "", incoming.fields.title ?? ""),
  )?.entry;
  if (!entry)
    throw new Error("Imported bibliography entry could not be identified");
  const result: ZoteroImport = {
    itemKey,
    citeKey: entry.key,
    at: now(),
    warnings: [],
  };
  try {
    const item = (await (
      await request(id, `/items/${itemKey}?format=json`)
    ).json()) as any;
    result.version = item.version;
    const children = (await (
      await request(id, `/items/${itemKey}/children?format=json&limit=100`)
    ).json()) as any[];
    const notes = children
      .filter((child) => child.data?.itemType === "note")
      .map((child) => ({ key: child.key, text: child.data.note }));
    if (notes.length) {
      const plain = notes
        .map((note) =>
          String(note.text ?? "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">"),
        )
        .join("\n\n");
      const bytes = Buffer.from(
        `Zotero notes for ${entry.key} — user notes, not the original paper.\nImported ${now()}\n\n${plain}`,
      );
      const upload = saveImportedFile(
        id,
        `zotero-notes-${itemKey}-${digest(plain).slice(0, 12)}.txt`,
        bytes,
      );
      result.notesPath = join(contextUploadsDir(id), upload.name);
    }
    const attachment = children.find(
      (child) => child.data?.contentType === "application/pdf",
    );
    if (attachment) {
      let pdf = await request(id, `/items/${attachment.key}/file`);
      if ([302, 303].includes(pdf.status)) {
        const url = new URL(pdf.headers.get("location") ?? "");
        // Never forward the Zotero key to attachment storage hosts.
        if (
          url.protocol !== "https:" ||
          !/(^|\.)zotero\.org$|(^|\.)amazonaws\.com$/.test(url.hostname)
        )
          throw new Error(
            "Attachment uses unsupported external storage; attach the PDF manually.",
          );
        pdf = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      }
      if (!pdf.ok) throw new Error(`Attachment returned HTTP ${pdf.status}`);
      if (Number(pdf.headers.get("content-length")) > 25 * 1024 * 1024)
        throw new Error("PDF exceeds 25 MB");
      const bytes = Buffer.from(await pdf.arrayBuffer());
      if (bytes.length > 25 * 1024 * 1024) throw new Error("PDF exceeds 25 MB");
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        throw new Error("Zotero attachment is not a PDF");
      const upload = saveImportedFile(
        id,
        `zotero-${itemKey}-${digest(bytes.toString("base64")).slice(0, 12)}.pdf`,
        bytes,
      );
      result.pdfPath = join(contextUploadsDir(id), upload.name);
      const read = await readPaper(id, dir, entry.key, {
        path: result.pdfPath,
      });
      if (read.basis !== "full_text") result.warnings.push(...read.limitations);
    } else
      result.warnings.push(
        "No PDF attachment found; attach the paper under External context if required.",
      );
  } catch (error: any) {
    result.warnings.push(
      `Bibliography imported; supplementary content unavailable: ${error.message}`,
    );
  }
  updateStore<Record<string, ZoteroImport>>(
    id,
    "zotero-imports",
    {},
    (all) => ({ ...all, [itemKey]: result }),
  );
  return result;
}
