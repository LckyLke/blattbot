import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureUniqueKey,
  findDuplicate,
  findEntrySpan,
  normalizeKey,
  parseBib,
  rewriteKey,
  type BibEntry,
} from "./bib.js";
import { findBibFiles } from "./latex.js";
import { loadSettings } from "./settings.js";

const CROSSREF_MAILTO = "blattbot@localhost.invalid";

export interface PaperHit {
  /** What to pass to add_citation: a DOI, "dblp:<key>", or "arxiv:<id>". */
  ref: string;
  doi?: string;
  title: string;
  authors: string;
  year?: number;
  venue?: string;
  citations?: number;
  /** Which index found it (crossref / semanticscholar / dblp). */
  source: string;
}

async function searchCrossref(queryText: string, limit: number): Promise<PaperHit[]> {
  const url =
    `https://api.crossref.org/works?query=${encodeURIComponent(queryText)}` +
    `&rows=${limit}` +
    `&select=DOI,title,author,issued,container-title,is-referenced-by-count` +
    `&mailto=${CROSSREF_MAILTO}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Crossref: HTTP ${res.status}`);
  const data: any = await res.json();
  return (data?.message?.items ?? [])
    .filter((it: any) => it.DOI && it.title?.[0])
    .map((it: any) => ({
      ref: it.DOI,
      doi: String(it.DOI).toLowerCase(),
      title: String(it.title[0]),
      authors: (it.author ?? [])
        .slice(0, 6)
        .map((a: any) => [a.given, a.family].filter(Boolean).join(" "))
        .join(", "),
      year: it.issued?.["date-parts"]?.[0]?.[0],
      venue: it["container-title"]?.[0],
      citations: it["is-referenced-by-count"],
      source: "crossref",
    }));
}

/** OpenAlex: free, fast, no key, and covers ML venues (incl. DOI-less NeurIPS/ICLR papers). */
async function searchOpenAlex(queryText: string, limit: number): Promise<PaperHit[]> {
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(queryText)}` +
    `&per-page=${limit}&mailto=${CROSSREF_MAILTO}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OpenAlex: HTTP ${res.status}`);
  const data: any = await res.json();
  return (data?.results ?? [])
    .filter((w: any) => w.display_name && w.id)
    .map((w: any) => {
      const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, "").toLowerCase() : undefined;
      const arxiv = extractArxivId(
        [w.primary_location, ...(w.locations ?? [])]
          .filter(Boolean)
          .map((l: any) => l.landing_page_url ?? l.pdf_url ?? ""),
      );
      const openalexId = String(w.id).split("/").pop();
      return {
        ref: doi ?? (arxiv ? `arxiv:${arxiv}` : `openalex:${openalexId}`),
        doi,
        title: String(w.display_name),
        authors: (w.authorships ?? [])
          .slice(0, 6)
          .map((a: any) => a.author?.display_name)
          .filter(Boolean)
          .join(", "),
        year: w.publication_year ?? undefined,
        venue: w.primary_location?.source?.display_name ?? undefined,
        citations: w.cited_by_count ?? undefined,
        source: "openalex",
      };
    });
}

function extractArxivId(urls: string[]): string | undefined {
  for (const u of urls) {
    const m = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})/i.exec(u);
    if (m) return m[1];
  }
  return undefined;
}

/** Semantic Scholar has by far the best coverage of ML venues (NeurIPS, ICML, ICLR). */
async function searchSemanticScholar(queryText: string, limit: number): Promise<PaperHit[]> {
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(queryText)}` +
    `&limit=${limit}&fields=title,authors,year,venue,externalIds,citationCount`;
  const key = loadSettings().s2ApiKey;
  const res = await fetch(url, {
    headers: key ? { "x-api-key": key } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Semantic Scholar: HTTP ${res.status}`);
  const data: any = await res.json();
  return (data?.data ?? [])
    .filter((p: any) => p.title)
    .map((p: any) => {
      const doi = p.externalIds?.DOI ? String(p.externalIds.DOI).toLowerCase() : undefined;
      const arxiv = p.externalIds?.ArXiv ? String(p.externalIds.ArXiv) : undefined;
      const ref = doi ?? (arxiv ? `arxiv:${arxiv}` : undefined);
      return {
        ref,
        doi,
        title: String(p.title),
        authors: (p.authors ?? [])
          .slice(0, 6)
          .map((a: any) => a.name)
          .filter(Boolean)
          .join(", "),
        year: p.year ?? undefined,
        venue: p.venue || undefined,
        citations: p.citationCount ?? undefined,
        source: "semanticscholar",
      };
    })
    .filter((p: any): p is PaperHit => Boolean(p.ref));
}

/** DBLP indexes essentially every CS publication and serves clean BibTeX per record. */
async function searchDblp(queryText: string, limit: number): Promise<PaperHit[]> {
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(queryText)}&format=json&h=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`DBLP: HTTP ${res.status}`);
  const data: any = await res.json();
  const hits: any[] = data?.result?.hits?.hit ?? [];
  return hits
    .map((h) => h.info)
    .filter((info: any) => info?.title && info?.key)
    .map((info: any) => {
      const authorField = info.authors?.author;
      const authorList = Array.isArray(authorField) ? authorField : authorField ? [authorField] : [];
      const doi = info.doi ? String(info.doi).toLowerCase() : undefined;
      return {
        ref: doi ?? `dblp:${info.key}`,
        doi,
        title: String(info.title).replace(/\.\s*$/, ""),
        authors: authorList
          .slice(0, 6)
          .map((a: any) => (typeof a === "string" ? a : a.text))
          .filter(Boolean)
          .join(", "),
        year: info.year ? Number(info.year) : undefined,
        venue: info.venue ? String(info.venue) : undefined,
        citations: undefined,
        source: "dblp",
      };
    });
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Merge hits from all sources: dedupe by DOI, then by normalized title. */
export function mergeHits(groups: PaperHit[][], limit: number): PaperHit[] {
  const out: PaperHit[] = [];
  const byDoi = new Map<string, PaperHit>();
  const byTitle = new Map<string, PaperHit>();
  for (const group of groups) {
    for (const hit of group) {
      const existing = (hit.doi && byDoi.get(hit.doi)) || byTitle.get(titleKey(hit.title));
      if (existing) {
        // Enrich the first occurrence with anything it was missing.
        existing.doi ??= hit.doi;
        existing.year ??= hit.year;
        existing.venue ??= hit.venue;
        existing.citations ??= hit.citations;
        if (existing.ref.startsWith("arxiv:") && hit.doi) existing.ref = hit.doi;
        continue;
      }
      out.push(hit);
      if (hit.doi) byDoi.set(hit.doi, hit);
      byTitle.set(titleKey(hit.title), hit);
    }
  }
  return out.slice(0, limit);
}

/**
 * Search Semantic Scholar, DBLP, and Crossref in parallel and merge the
 * results. A single failing index never sinks the search.
 */
export async function searchPapers(queryText: string, limit = 5): Promise<PaperHit[]> {
  const n = Math.min(Math.max(limit, 1), 15);
  const settled = await Promise.allSettled([
    searchOpenAlex(queryText, n),
    searchSemanticScholar(queryText, n),
    searchDblp(queryText, n),
    searchCrossref(queryText, n),
  ]);
  const groups = settled
    .filter((s): s is PromiseFulfilledResult<PaperHit[]> => s.status === "fulfilled")
    .map((s) => s.value);
  if (groups.length === 0) {
    const reasons = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => String(s.reason?.message ?? s.reason));
    throw new Error(`All paper indexes failed: ${reasons.join("; ")}`);
  }
  return mergeHits(groups, Math.max(n, 8));
}

/** Fetch a BibTeX entry for a DOI via content negotiation, with a Crossref fallback. */
export async function fetchBibtex(doi: string): Promise<string> {
  const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  const attempts = [
    { url: `https://doi.org/${encodeURIComponent(clean).replace(/%2F/g, "/")}`, headers: { Accept: "application/x-bibtex" } },
    { url: `https://api.crossref.org/works/${encodeURIComponent(clean).replace(/%2F/g, "/")}/transform/application/x-bibtex`, headers: {} },
  ];
  let lastError = "";
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        headers: attempt.headers,
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.startsWith("@")) return text;
        lastError = `unexpected response body from ${attempt.url}`;
      } else {
        lastError = `HTTP ${res.status} from ${attempt.url}`;
      }
    } catch (err: any) {
      lastError = String(err?.message ?? err);
    }
  }
  throw new Error(`Could not fetch BibTeX for DOI ${clean}: ${lastError}`);
}

/** Build a BibTeX entry from an arXiv Atom API response (arXiv serves no BibTeX itself). */
export function arxivAtomToBibtex(xml: string, arxivId: string): string {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) throw new Error(`arXiv returned no entry for ${arxivId}`);
  const strip = (s: string) => s.replace(/\s+/g, " ").trim();
  const title = strip(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? "");
  if (!title) throw new Error(`arXiv entry for ${arxivId} has no title`);
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => strip(m[1]));
  const year = /<published>(\d{4})/.exec(entry)?.[1];
  const doi = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(entry)?.[1]?.trim();
  const fields = [
    `  title = {${title}}`,
    `  author = {${authors.join(" and ")}}`,
    year ? `  year = {${year}}` : null,
    `  eprint = {${arxivId}}`,
    `  archivePrefix = {arXiv}`,
    doi ? `  doi = {${doi}}` : null,
    `  url = {https://arxiv.org/abs/${arxivId}}`,
  ].filter(Boolean);
  return `@misc{arxiv${arxivId.replace(/[^a-zA-Z0-9]/g, "")},\n${fields.join(",\n")}\n}`;
}

/** Build a BibTeX entry from an OpenAlex work record (for DOI-less papers, e.g. old NeurIPS). */
export function openAlexWorkToBibtex(work: any): string {
  const title = work?.display_name;
  if (!title) throw new Error("OpenAlex work has no title");
  const authors = (work.authorships ?? [])
    .map((a: any) => a.author?.display_name)
    .filter(Boolean)
    .join(" and ");
  const year = work.publication_year;
  const venue = work.primary_location?.source?.display_name;
  const doi = work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//, "") : undefined;
  const sourceType = work.primary_location?.source?.type;
  const type = sourceType === "journal" ? "article" : venue ? "inproceedings" : "misc";
  const venueField = type === "article" ? "journal" : "booktitle";
  const id = String(work.id ?? "openalex").split("/").pop();
  const fields = [
    `  title = {${title}}`,
    authors ? `  author = {${authors}}` : null,
    year ? `  year = {${year}}` : null,
    venue ? `  ${venueField} = {${venue}}` : null,
    doi ? `  doi = {${doi}}` : null,
    work.primary_location?.landing_page_url ? `  url = {${work.primary_location.landing_page_url}}` : null,
  ].filter(Boolean);
  return `@${type}{${id},\n${fields.join(",\n")}\n}`;
}

/**
 * Fetch BibTeX for any supported reference:
 *   - a DOI (via doi.org content negotiation / Crossref)
 *   - "dblp:<key>" (DBLP's own BibTeX — best quality for CS venues)
 *   - "arxiv:<id>" (built from the arXiv Atom API)
 *   - "openalex:<id>" (built from OpenAlex metadata)
 */
export async function fetchBibtexByRef(ref: string): Promise<string> {
  const openalex = /^openalex:(W\w+)$/i.exec(ref.trim());
  if (openalex) {
    const res = await fetch(`https://api.openalex.org/works/${openalex[1]}?mailto=${CROSSREF_MAILTO}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`OpenAlex record ${openalex[1]} failed: HTTP ${res.status}`);
    return openAlexWorkToBibtex(await res.json());
  }
  const trimmed = ref.trim();
  const dblp = /^dblp:(.+)$/i.exec(trimmed);
  if (dblp) {
    const res = await fetch(`https://dblp.org/rec/${dblp[1]}.bib`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`DBLP record ${dblp[1]} failed: HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (!text.startsWith("@")) throw new Error(`DBLP record ${dblp[1]} returned no BibTeX`);
    return text;
  }
  const arxiv = /^arxiv:(.+)$/i.exec(trimmed);
  if (arxiv) {
    const id = arxiv[1].replace(/^abs\//, "");
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`arXiv query for ${id} failed: HTTP ${res.status}`);
    return arxivAtomToBibtex(await res.text(), id);
  }
  return fetchBibtex(trimmed);
}

export interface AddCitationResult {
  status: "added" | "duplicate";
  key: string;
  bibFile: string;
  entryPreview?: string;
}

/** Read every entry across all .bib files in a project. */
export function readAllBibEntries(projectPath: string): { file: string; entry: BibEntry }[] {
  const out: { file: string; entry: BibEntry }[] = [];
  for (const file of findBibFiles(projectPath)) {
    try {
      const entries = parseBib(readFileSync(join(projectPath, file), "utf8"));
      out.push(...entries.map((entry) => ({ file, entry })));
    } catch {
      /* unreadable bib — skip */
    }
  }
  return out;
}

export interface ImportBibResult {
  added: string[];
  skipped: { key: string; reason: string }[];
  bibFile: string;
}

/**
 * Import pasted BibTeX: parse, dedupe each entry against the existing
 * bibliography (exact key, DOI, or normalized title) and against the batch
 * itself, then append the new entries verbatim to the target .bib file.
 */
export function importBibtex(projectPath: string, bibtex: string, bibFile?: string): ImportBibResult {
  const incoming = parseBib(bibtex);
  if (incoming.length === 0) throw new Error("no BibTeX entries found in the pasted text");

  const existing = readAllBibEntries(projectPath).map((x) => x.entry);
  const target = bibFile ?? findBibFiles(projectPath)[0] ?? "references.bib";
  const targetPath = join(projectPath, target);

  const added: string[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const chunks: string[] = [];
  for (const entry of incoming) {
    if (!entry.key) {
      skipped.push({ key: "(no key)", reason: "entry has no citation key" });
      continue;
    }
    if (existing.some((e) => e.key === entry.key)) {
      skipped.push({ key: entry.key, reason: `key already in bibliography` });
      continue;
    }
    const dup = findDuplicate(existing, entry.fields.doi, entry.fields.title);
    if (dup) {
      skipped.push({ key: entry.key, reason: `duplicate of ${dup.key} (same ${dup.reason})` });
      continue;
    }
    existing.push(entry); // dedupe later batch entries against this one too
    added.push(entry.key);
    chunks.push(entry.raw.trim());
  }

  if (chunks.length > 0) {
    if (existsSync(targetPath)) {
      const current = readFileSync(targetPath, "utf8");
      appendFileSync(targetPath, (current.endsWith("\n") ? "" : "\n") + "\n" + chunks.join("\n\n") + "\n");
    } else {
      writeFileSync(targetPath, chunks.join("\n\n") + "\n");
    }
  }
  return { added, skipped, bibFile: target };
}

// ---- Manual reference editing (single-entry writes to the real .bib files) --

export interface RefWriteResult {
  key: string;
  bibFile: string;
}

/** Parse pasted BibTeX that must contain exactly one keyed entry. */
function parseSingleEntry(bibtex: string): BibEntry {
  const incoming = parseBib(bibtex);
  if (incoming.length === 0) throw new Error("no BibTeX entry found in the text");
  if (incoming.length > 1) throw new Error("provide exactly one BibTeX entry");
  const entry = incoming[0];
  if (!entry.key) throw new Error("the entry has no citation key");
  return entry;
}

/**
 * Append one pasted BibTeX entry to a .bib file (default: the first existing
 * one, else references.bib). A key collision auto-renames the new entry.
 */
export function addRefEntry(projectPath: string, bibtex: string, bibFile?: string): RefWriteResult {
  const entry = parseSingleEntry(bibtex);
  const existingKeys = new Set(readAllBibEntries(projectPath).map((x) => x.entry.key));
  const key = ensureUniqueKey(entry.key, existingKeys);
  const raw = (key === entry.key ? entry.raw : rewriteKey(entry.raw, key)).trim();

  const target = bibFile ?? findBibFiles(projectPath)[0] ?? "references.bib";
  const targetPath = join(projectPath, target);
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath, "utf8");
    appendFileSync(targetPath, (current.endsWith("\n") ? "" : "\n") + "\n" + raw + "\n");
  } else {
    writeFileSync(targetPath, raw + "\n");
  }
  return { key, bibFile: target };
}

/**
 * Replace the entry `oldKey` in place with the edited BibTeX (exactly one
 * entry). A different key means a rename, kept unique against every other key.
 */
export function updateRefEntry(projectPath: string, oldKey: string, bibtex: string): RefWriteResult {
  const entry = parseSingleEntry(bibtex);
  const all = readAllBibEntries(projectPath);
  const hit = all.find((x) => x.entry.key === oldKey);
  if (!hit) throw new Error(`unknown citation key: ${oldKey}`);

  const path = join(projectPath, hit.file);
  const content = readFileSync(path, "utf8");
  const span = findEntrySpan(content, oldKey);
  if (!span) throw new Error(`could not locate @${oldKey} in ${hit.file}`);

  const others = new Set(all.map((x) => x.entry.key).filter((k) => k !== oldKey));
  const key = ensureUniqueKey(entry.key, others);
  const raw = (key === entry.key ? entry.raw : rewriteKey(entry.raw, key)).trim();

  writeFileSync(path, content.slice(0, span.start) + raw + content.slice(span.end));
  return { key, bibFile: hit.file };
}

/** Remove the entry `key` (plus one adjacent blank line) from its .bib file. */
export function deleteRefEntry(projectPath: string, key: string): { bibFile: string } {
  const all = readAllBibEntries(projectPath);
  const hit = all.find((x) => x.entry.key === key);
  if (!hit) throw new Error(`unknown citation key: ${key}`);

  const path = join(projectPath, hit.file);
  const content = readFileSync(path, "utf8");
  const span = findEntrySpan(content, key);
  if (!span) throw new Error(`could not locate @${key} in ${hit.file}`);

  let before = content.slice(0, span.start);
  let after = content.slice(span.end);
  if (after.startsWith("\n")) after = after.slice(1); // the entry's own line ending
  if (after.startsWith("\n")) after = after.slice(1); // one adjacent blank line
  if (after.trim() === "") {
    // Deleted the last entry — also drop the blank line that preceded it.
    after = "";
    before = before.replace(/\n{2,}$/, "\n");
  }
  writeFileSync(path, before + after);
  return { bibFile: hit.file };
}

/**
 * The whole bibliography as one BibTeX document: the raw contents of every
 * .bib file concatenated, with a provenance comment per file.
 */
export function exportBibliography(projectPath: string): string {
  const files = findBibFiles(projectPath);
  const parts: string[] = [];
  for (const file of files) {
    try {
      const text = readFileSync(join(projectPath, file), "utf8").trim();
      if (!text) continue;
      parts.push(files.length > 1 ? `% ---- ${file} ----\n\n${text}` : text);
    } catch {
      /* unreadable bib — skip */
    }
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}

/**
 * Fetch BibTeX for a reference (DOI, dblp:<key>, or arxiv:<id>), dedupe
 * against the project's bibliography, normalize the key, and append to a .bib file.
 */
export async function addCitation(projectPath: string, ref: string, bibFile?: string): Promise<AddCitationResult> {
  const raw = await fetchBibtexByRef(ref);
  const parsed = parseBib(raw)[0];
  if (!parsed) throw new Error("Fetched BibTeX could not be parsed.");

  const all = readAllBibEntries(projectPath);
  const dup = findDuplicate(all.map((x) => x.entry), parsed.fields.doi ?? ref, parsed.fields.title);
  if (dup) {
    const file = all.find((x) => x.entry.key === dup.key)?.file ?? "";
    return { status: "duplicate", key: dup.key, bibFile: file };
  }

  const target = bibFile ?? findBibFiles(projectPath)[0] ?? "references.bib";
  const targetPath = join(projectPath, target);

  const existingKeys = new Set(all.map((x) => x.entry.key));
  const desired = normalizeKey(parsed.fields.author, parsed.fields.year, parsed.fields.title);
  const key = ensureUniqueKey(desired, existingKeys);
  const entry = rewriteKey(raw, key);

  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath, "utf8");
    appendFileSync(targetPath, (current.endsWith("\n") ? "" : "\n") + "\n" + entry + "\n");
  } else {
    writeFileSync(targetPath, entry + "\n");
  }
  return { status: "added", key, bibFile: target, entryPreview: entry.split("\n").slice(0, 3).join("\n") };
}
