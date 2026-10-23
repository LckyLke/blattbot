/**
 * Source identity for research artifacts: which bibliography entry and which
 * exact source text a saved result was derived from, and whether that is
 * still current. Reading notes and the paper library use these to mark their
 * results stale; validQuotes keeps model-proposed quotations to verbatim text
 * on the cited page.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { readAllBibEntries } from "../citations.js";
import { paperPdfPath, readPaperStore, type PaperContent } from "../papers.js";
import { getProject } from "../config.js";
import { contextDirectories, contextUploadsDir } from "../context.js";
import { resolveReadPath } from "../backends/paths.js";
import { pdfTextRevision } from "../pdftext.js";
import { digest, now } from "./store.js";

export const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
export const quoteSchema = z.object({
  page: z.number().int().min(1),
  quote: z.string().trim().min(8).max(4000),
});
export type SourceQuote = z.infer<typeof quoteSchema>;
export interface SourceVersion {
  key: string;
  title: string;
  basis: PaperContent["basis"];
  source?: string;
  fileHash?: string;
  extractionHash?: string;
  textHash: string;
  entryHash: string;
  at: string;
}
export function bibHash(dir: string, key: string): string {
  const fields = readAllBibEntries(dir).find((item) => item.entry.key === key)
    ?.entry.fields;
  return digest(fields ?? null);
}
export function localSourcePath(
  id: string,
  dir: string,
  key: string,
): string | null {
  const local = readPaperStore(id)[key]?.localSource;
  if (local) {
    const project = getProject(id);
    try {
      return resolveReadPath(
        dir,
        project ? contextDirectories(project) : [contextUploadsDir(id)],
        local.path,
      );
    } catch {
      return null;
    }
  }
  return paperPdfPath(id, key);
}
export function sourceVersion(
  id: string,
  dir: string,
  content: PaperContent,
): SourceVersion {
  const path = content.basis === "full_text" ? localSourcePath(id, dir, content.key) : null;
  return {
    key: content.key,
    title: content.title,
    basis: content.basis,
    source: content.source,
    entryHash: bibHash(dir, content.key),
    textHash: digest(content.pages),
    fileHash:
      path && existsSync(path)
        ? digest(readFileSync(path).toString("base64"))
        : undefined,
    extractionHash:
      path && existsSync(path) ? pdfTextRevision(path) : undefined,
    at: now(),
  };
}
export function sourceCurrent(
  id: string,
  dir: string,
  source: SourceVersion,
): boolean {
  if (source.entryHash !== bibHash(dir, source.key)) return false;
  if (!source.fileHash) {
    // A refreshed publisher summary invalidates verdicts quoting the older text.
    const latest = readPaperStore(id)[source.key]?.webSource;
    if (latest && latest.url === source.source) return source.textHash === digest([latest.text]);
    return !latest || Date.parse(latest.retrievedAt) <= Date.parse(source.at);
  }
  const path = localSourcePath(id, dir, source.key);
  return Boolean(
    path &&
      existsSync(path) &&
      digest(readFileSync(path).toString("base64")) === source.fileHash &&
      pdfTextRevision(path) === source.extractionHash,
  );
}
export function validQuotes(
  quotes: SourceQuote[],
  pages: string[],
): SourceQuote[] {
  return quotes.filter(
    (quote) =>
      normalize(quote.quote).length >= 8 &&
      Number.isInteger(quote.page) &&
      quote.page >= 1 &&
      quote.page <= pages.length &&
      normalize(pages[quote.page - 1]).includes(normalize(quote.quote)),
  );
}
