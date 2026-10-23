import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readAllBibEntries,
  searchPapers,
  type PaperHit,
} from "../citations.js";
import { entryDoi } from "../bib.js";
import { arxivIdFromEntry, titlesSimilar } from "../papers.js";
import { now, updateStore } from "./store.js";
import { openAlexHeaders } from "../research-providers.js";
import { SourceServiceError } from "./source-failure.js";

export interface SearchRun {
  id: string;
  at: string;
  kind: "search" | "references" | "citing";
  query: string;
  criteria: string;
  results: PaperHit[];
  total?: number;
  cursor?: string;
  error?: string;
  decisions: Record<
    string,
    { decision: "include" | "exclude" | "pending"; reason: string }
  >;
}
function record(id: string, run: SearchRun): SearchRun {
  updateStore<SearchRun[]>(id, "searches", [], (runs) =>
    [...runs, run].slice(-300),
  );
  return run;
}
export async function searchLiterature(
  id: string,
  query: string,
  limit = 10,
  criteria = "",
): Promise<SearchRun> {
  query = z.string().min(1).max(1000).parse(query);
  z.number().int().min(1).max(30).parse(limit);
  const run: SearchRun = {
    id: randomUUID(),
    at: now(),
    kind: "search",
    query,
    criteria: z.string().max(4000).parse(criteria),
    results: [],
    decisions: {},
  };
  try {
    run.results = await searchPapers(query, limit);
  } catch (error: any) {
    run.error = String(error.message ?? error);
  }
  return record(id, run);
}
export async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<any> {
  const auth = new URL(url).hostname === "api.openalex.org" ? openAlexHeaders() : {};
  let result: Response;
  try {
    result = await fetch(url, {
      headers: { ...auth, ...headers } as Record<string, string>,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
      redirect: "error",
    });
  } catch (error: any) {
    signal?.throwIfAborted();
    const code = error?.cause?.code;
    throw new Error(
      `Network request to ${new URL(url).hostname} failed${typeof code === "string" && /^[A-Z_0-9]+$/.test(code) ? ` (${code})` : ""}: ${error?.name === "TimeoutError" ? "timed out" : "fetch failed"}`,
    );
  }
  if (!result.ok) {
    const after = result.headers.get("retry-after");
    const reset = result.headers.get("x-ratelimit-reset");
    const retryTime = after
      ? /^\d+(\.\d+)?$/.test(after)
        ? Date.now() + Number(after) * 1000
        : Date.parse(after)
      : result.status === 429 &&
          result.headers.get("x-ratelimit-remaining") === "0" &&
          reset
        ? Date.now() + Number(reset) * 1000
        : NaN;
    throw new SourceServiceError(
      `Source service returned HTTP ${result.status}${result.status === 429 ? " (rate limited; retry later)" : ""}`,
      result.status,
      Number.isFinite(retryTime)
        ? new Date(retryTime).toISOString()
        : undefined,
    );
  }
  return result.json();
}
export async function openAlexWork(
  dir: string,
  key: string,
  signal?: AbortSignal,
): Promise<any> {
  const entry = readAllBibEntries(dir).find(
    (item) => item.entry.key === key,
  )?.entry;
  if (!entry) throw new Error("unknown citation key");
  if (
    readAllBibEntries(dir).filter((item) => item.entry.key === key).length > 1
  )
    throw new Error(
      "Duplicate citation key; resolve the bibliography ambiguity first.",
    );
  const arxiv = arxivIdFromEntry(entry)?.replace(/v\d+$/i, "");
  const doi = entryDoi(entry.fields) ?? (arxiv ? `10.48550/arxiv.${arxiv}` : undefined);
  const matches = (work: any) =>
    matchesOpenAlexIdentity(work, entry.fields, doi, entry.type);
  const search = async () => {
    // Phrase searches avoid highly cited papers merely discussing this title.
    const title = (entry.fields.title ?? key).replace(/[{}"\\]/g, "").trim();
    const results = await fetchJson(
      `https://api.openalex.org/works?search=${encodeURIComponent(`"${title}"`)}&per-page=20`,
      {},
      signal,
    );
    return results.results?.find(matches);
  };
  let data;
  try {
    data = doi
      ? await fetchJson(
          `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`,
          {},
          signal,
        )
      : await search();
  } catch (error) {
    if (!doi || !(error instanceof SourceServiceError) || error.status !== 404)
      throw error;
    data = await search();
  }
  if (!data?.id || !matches(data)) {
    const w3c = /^https?:\/\/(?:www\.)?w3\.org\/TR\//i.test(entry.fields.url ?? "");
    throw new Error(
      w3c
        ? "OpenAlex could not resolve this W3C standard reliably. Use its official source page; citation connections are unavailable. This does not mean the reference is invalid."
        : "OpenAlex could not resolve this bibliography entry reliably. Check its title and identifiers; it may be missing from the index. You can still use the original source.",
    );
  }
  return data;
}
function matchesOpenAlexIdentity(
  work: any,
  fields: Record<string, string>,
  doi?: string,
  entryType?: string,
) {
  const book = entryType?.toLowerCase() === "book";
  // A book review or another edition must not replace the cited book.
  if (book && work.type && work.type !== "book") return false;
  if (book && fields.year && work.publication_year &&
      Math.abs(Number(fields.year) - work.publication_year) > 1) return false;
  if (titlesSimilar(work.display_name ?? "", fields.title ?? "")) return true;
  // Some OpenAlex DOI records omit a subtitle (e.g. "Yago"). Accept a
  // matching main title only when DOI, publication year and author agree too.
  // Book records can omit all editors: exact DOI + main title + year + book
  // type still identifies the volume. Conflicting indexed authors reject it.
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const main = normalize((fields.title ?? "").split(/[:—–]/)[0]);
  const indexed = normalize(work.display_name ?? "");
  const exactDoi =
    typeof work.doi === "string" &&
    work.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() ===
      doi?.toLowerCase();
  const year = Number(fields.year);
  const families = (fields.author || fields.editor || "")
    .split(/\s+and\s+/)
    .map((name) =>
      normalize(
        name.includes(",")
          ? name.split(",")[0]
          : (name.trim().split(/\s+/).at(-1) ?? ""),
      ),
    )
    .filter((name) => name.length > 2);
  const authorMatch = (work.authorships ?? []).some((a: any) => {
    const name = normalize(a.author?.display_name ?? "");
    return families.some(
      (family) => name === family || name.endsWith(` ${family}`),
    );
  });
  return (
    exactDoi &&
    main.length >= 4 &&
    main === indexed &&
    Number.isFinite(year) &&
    year > 1000 &&
    Math.abs(work.publication_year - year) <= 1 &&
    (authorMatch || (book && work.type === "book" && !work.authorships?.length))
  );
}
