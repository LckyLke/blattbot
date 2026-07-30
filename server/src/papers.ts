/**
 * Paper metadata + persistent TL;DR summaries — the Zotero-lite layer.
 *
 * Resolves bib entries to Semantic Scholar records (DOI → arXiv id → title
 * search), builds a short summary (S2 TL;DR → agent condensation of the
 * abstract → the abstract verbatim), caches open-access PDFs, and persists
 * everything per project under DATA_DIR/papers/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { loadSettings } from "./settings.js";
import { readAllBibEntries } from "./citations.js";
import type { BibEntry } from "./bib.js";

// ---- Persistent per-project store -----------------------------------------

export type SummarySource = "s2-tldr" | "agent" | "abstract";

export interface PaperRecord {
  summary?: string;
  source?: SummarySource;
  updatedAt: string;
  /** Semantic Scholar page for the paper. */
  s2Url?: string;
  /** Open-access PDF location on the web. */
  oaPdfUrl?: string;
  /** Cached PDF filename inside DATA_DIR/papers/<projectId>/. */
  pdfFile?: string;
}

export type PaperStore = Record<string, PaperRecord>;

const papersDir = () => join(DATA_DIR, "papers");
const storePath = (projectId: string) => join(papersDir(), `${projectId}.json`);
const pdfDir = (projectId: string) => join(papersDir(), projectId);

export function readPaperStore(projectId: string): PaperStore {
  try {
    return JSON.parse(readFileSync(storePath(projectId), "utf8")) as PaperStore;
  } catch {
    return {};
  }
}

/** Merge a patch into a key's record and persist. Returns the updated record. */
export function writePaperRecord(projectId: string, citeKey: string, patch: Partial<PaperRecord>): PaperRecord {
  const store = readPaperStore(projectId);
  const next: PaperRecord = { ...store[citeKey], ...patch, updatedAt: new Date().toISOString() };
  store[citeKey] = next;
  mkdirSync(papersDir(), { recursive: true });
  writeFileSync(storePath(projectId), JSON.stringify(store, null, 2));
  return next;
}

/** Cite keys can contain /:& etc. — flatten to a safe filename stem. */
export function sanitizeKeyForFile(citeKey: string): string {
  return citeKey.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "entry";
}

/** Absolute path of the cached PDF for a key, or null if none is cached. */
export function paperPdfPath(projectId: string, citeKey: string, store = readPaperStore(projectId)): string | null {
  const rec = store[citeKey];
  if (!rec?.pdfFile) return null;
  const abs = join(pdfDir(projectId), rec.pdfFile);
  return existsSync(abs) ? abs : null;
}

// ---- Semantic Scholar resolution ------------------------------------------

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "title,tldr,abstract,url,openAccessPdf,externalIds,year";

export interface S2Paper {
  title?: string;
  tldr?: { text?: string } | null;
  abstract?: string | null;
  url?: string;
  openAccessPdf?: { url?: string } | null;
  externalIds?: Record<string, unknown> | null;
  year?: number | null;
}

export class RateLimitError extends Error {
  constructor() {
    super("Semantic Scholar rate limited — add a Semantic Scholar API key in Settings or retry later");
    this.name = "RateLimitError";
  }
}

/** GET an S2 endpoint. Returns null on 404, throws RateLimitError on 429. */
async function s2Get(path: string): Promise<any | null> {
  const key = loadSettings().s2ApiKey;
  const res = await fetch(`${S2_BASE}${path}`, {
    headers: key ? { "x-api-key": key } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return null;
  if (res.status === 429) throw new RateLimitError();
  if (!res.ok) throw new Error(`Semantic Scholar: HTTP ${res.status}`);
  return res.json();
}

/** Extract an arXiv id from a bib entry (eprint field or a 10.48550 DOI). */
export function arxivIdFromEntry(entry: Pick<BibEntry, "fields">): string | undefined {
  const eprint = entry.fields.eprint?.trim().replace(/^arxiv:/i, "");
  if (eprint && /^([0-9]{4}\.[0-9]{4,5}|[a-z-]+(\.[A-Z]{2})?\/[0-9]{7})(v[0-9]+)?$/i.test(eprint)) {
    return eprint;
  }
  const doi = entry.fields.doi?.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  const m = doi ? /^10\.48550\/arxiv\.(.+)$/.exec(doi) : null;
  if (m) return m[1];
  return undefined;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Loose title match: normalized equality or heavy word overlap. */
export function titlesSimilar(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(" "));
  const wb = new Set(nb.split(" "));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size) >= 0.8;
}

/**
 * Resolve a bib entry to its Semantic Scholar record: DOI first, then arXiv
 * id, then a title search verified by title similarity. Returns null when the
 * paper cannot be found.
 */
export async function resolveS2Paper(entry: Pick<BibEntry, "fields">): Promise<S2Paper | null> {
  const doi = entry.fields.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) {
    const paper = await s2Get(`/paper/DOI:${encodeURIComponent(doi)}?fields=${S2_FIELDS}`);
    if (paper) return paper as S2Paper;
  }
  const arxivId = arxivIdFromEntry(entry);
  if (arxivId) {
    const paper = await s2Get(`/paper/arXiv:${encodeURIComponent(arxivId.replace(/v[0-9]+$/, ""))}?fields=${S2_FIELDS}`);
    if (paper) return paper as S2Paper;
  }
  const title = entry.fields.title?.trim();
  if (title) {
    const data = await s2Get(`/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${S2_FIELDS}`);
    const hit = data?.data?.[0];
    if (hit?.title && titlesSimilar(String(hit.title), title)) return hit as S2Paper;
  }
  return null;
}

// ---- TL;DR summaries -------------------------------------------------------

function findEntry(projectPath: string, citeKey: string): BibEntry {
  const match = readAllBibEntries(projectPath).find(({ entry }) => entry.key === citeKey);
  if (!match) throw new Error(`unknown citation key: ${citeKey}`);
  return match.entry;
}

/** Open-access PDF URL for an entry: S2's openAccessPdf, else the arXiv PDF. */
function oaPdfUrlFor(entry: Pick<BibEntry, "fields">, s2: S2Paper | null): string | undefined {
  if (s2?.openAccessPdf?.url) return s2.openAccessPdf.url;
  const arxivId = arxivIdFromEntry(entry) ?? (s2?.externalIds?.ArXiv ? String(s2.externalIds.ArXiv) : undefined);
  return arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined;
}

type Summarizer = (title: string, abstract: string) => Promise<string>;

/** Default summarizer: a one-shot agent call (lazy import keeps tests light). */
async function agentSummarize(title: string, abstract: string): Promise<string> {
  const { runOneShot } = await import("./agent.js");
  return runOneShot(
    "Condense this paper abstract into a 2-3 sentence TL;DR for a researcher skimming a reference list. " +
      "Reply with only the summary text — no preamble, no markdown.\n\n" +
      `Title: ${title}\n\nAbstract: ${abstract}`,
  );
}

export interface TldrResult {
  summary: string;
  source: SummarySource;
}

/**
 * Get (or build) the persistent TL;DR for a cite key. Chain:
 * S2 tldr → agent condensation of the abstract → abstract verbatim.
 * Stored summaries are permanent until regenerated with force.
 */
export async function getTldr(
  projectId: string,
  projectPath: string,
  citeKey: string,
  opts: { force?: boolean; summarize?: Summarizer } = {},
): Promise<TldrResult> {
  const stored = readPaperStore(projectId)[citeKey];
  if (stored?.summary && stored.source && !opts.force) {
    return { summary: stored.summary, source: stored.source };
  }

  const entry = findEntry(projectPath, citeKey);
  let s2: S2Paper | null = null;
  try {
    s2 = await resolveS2Paper(entry);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    s2 = null; // S2 unreachable — the bib entry's own abstract may still work
  }

  let summary: string | undefined;
  let source: SummarySource | undefined;
  const tldrText = s2?.tldr?.text?.trim();
  if (tldrText) {
    summary = tldrText;
    source = "s2-tldr";
  } else {
    const abstract = (s2?.abstract ?? entry.fields.abstract)?.trim();
    if (!abstract) throw new Error("no abstract available");
    const title = s2?.title ?? entry.fields.title ?? citeKey;
    try {
      summary = await (opts.summarize ?? agentSummarize)(title, abstract);
      source = "agent";
    } catch {
      summary = abstract;
      source = "abstract";
    }
  }

  writePaperRecord(projectId, citeKey, {
    summary,
    source,
    s2Url: s2?.url ?? stored?.s2Url,
    oaPdfUrl: oaPdfUrlFor(entry, s2) ?? stored?.oaPdfUrl,
  });
  return { summary, source: source! };
}

// ---- Open-access PDF cache -------------------------------------------------

export class NoPdfError extends Error {
  constructor() {
    super("no open-access PDF found");
    this.name = "NoPdfError";
  }
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "BlattBot/0.1 (mailto:blattbot@localhost.invalid)" },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Some "open access" URLs serve an HTML landing page — verify the magic.
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Ensure the open-access PDF for a cite key is cached locally; returns the
 * absolute path. Throws NoPdfError when no OA PDF exists or none downloads.
 */
export async function ensurePaperPdf(projectId: string, projectPath: string, citeKey: string): Promise<string> {
  const cached = paperPdfPath(projectId, citeKey);
  if (cached) return cached;

  const entry = findEntry(projectPath, citeKey);
  const stored = readPaperStore(projectId)[citeKey];
  const candidates = new Set<string>();
  if (stored?.oaPdfUrl) candidates.add(stored.oaPdfUrl);
  let rateLimited: RateLimitError | null = null;
  if (candidates.size === 0) {
    let s2: S2Paper | null = null;
    try {
      s2 = await resolveS2Paper(entry);
    } catch (err) {
      // A rate-limited S2 must not block the arXiv fallback below.
      if (err instanceof RateLimitError) rateLimited = err;
      s2 = null;
    }
    const url = oaPdfUrlFor(entry, s2);
    if (url) candidates.add(url);
    if (s2?.url) writePaperRecord(projectId, citeKey, { s2Url: s2.url, oaPdfUrl: url ?? stored?.oaPdfUrl });
  }
  // The arXiv mirror is a dependable fallback even when S2 lists another URL.
  const arxivId = arxivIdFromEntry(entry);
  if (arxivId) candidates.add(`https://arxiv.org/pdf/${arxivId}`);
  if (candidates.size === 0) throw rateLimited ?? new NoPdfError();

  for (const url of candidates) {
    const buf = await downloadPdf(url);
    if (!buf) continue;
    const filename = `${sanitizeKeyForFile(citeKey)}.pdf`;
    mkdirSync(pdfDir(projectId), { recursive: true });
    writeFileSync(join(pdfDir(projectId), filename), buf);
    writePaperRecord(projectId, citeKey, { pdfFile: filename, oaPdfUrl: url });
    return join(pdfDir(projectId), filename);
  }
  throw new NoPdfError();
}
