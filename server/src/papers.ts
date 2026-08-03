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
import {
  CROSSREF_MAILTO,
  readAllBibEntries,
  searchCrossref,
  searchOpenAlex,
  searchPapers,
  type PaperHit,
} from "./citations.js";
import { entryDoi, type BibEntry } from "./bib.js";

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

// ---- OpenAlex resolution ----------------------------------------------------
// A second, keyless index (generous "polite pool" limits via the mailto
// param below) for the open-access PDF URL and abstract — tried when S2 is
// rate-limited, unreachable, or simply has no OA link for a work.

const OPENALEX_BASE = "https://api.openalex.org/works";

export interface OpenAlexPaper {
  title?: string;
  abstract?: string;
  oaUrl?: string;
}

/** OpenAlex ships abstracts as a word → positions inverted index; rebuild the text. */
function reconstructAbstract(index: unknown): string | undefined {
  if (!index || typeof index !== "object") return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, number[]>)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.join(" ").trim();
  return text.length > 0 ? text : undefined;
}

function openAlexPaperFromWork(work: any): OpenAlexPaper {
  return {
    title: work?.display_name ?? undefined,
    abstract: reconstructAbstract(work?.abstract_inverted_index),
    oaUrl: work?.open_access?.oa_url ?? work?.best_oa_location?.pdf_url ?? undefined,
  };
}

/** GET an OpenAlex works endpoint. Returns null on 404 or any other non-OK status. */
async function openAlexGet(path: string): Promise<any | null> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${OPENALEX_BASE}${path}${sep}mailto=${CROSSREF_MAILTO}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Resolve a bib entry on OpenAlex: DOI first, then a title search verified by
 * title similarity. Never throws — a failed fallback must not be worse than
 * having no fallback, so any error just means "no OpenAlex record".
 */
export async function resolveOpenAlexPaper(entry: Pick<BibEntry, "fields">): Promise<OpenAlexPaper | null> {
  const doi = entry.fields.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) {
    try {
      const work = await openAlexGet(`/doi:${encodeURIComponent(doi)}`);
      if (work) return openAlexPaperFromWork(work);
    } catch {
      /* fall through to a title search */
    }
  }
  const title = entry.fields.title?.trim();
  if (!title) return null;
  try {
    const data = await openAlexGet(`?search=${encodeURIComponent(title)}&per-page=1`);
    const hit = data?.results?.[0];
    if (hit?.display_name && titlesSimilar(String(hit.display_name), title)) return openAlexPaperFromWork(hit);
  } catch {
    /* no match */
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
 * S2 tldr → agent condensation of the abstract (S2's, else OpenAlex's, else
 * the bib entry's own) → abstract verbatim.
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
  let rateLimited: RateLimitError | null = null;
  try {
    s2 = await resolveS2Paper(entry);
  } catch (err) {
    // A rate-limited S2 must not block the OpenAlex/abstract fallbacks below.
    if (err instanceof RateLimitError) rateLimited = err;
    s2 = null;
  }

  let summary: string | undefined;
  let source: SummarySource | undefined;
  let openAlex: OpenAlexPaper | null = null;
  const tldrText = s2?.tldr?.text?.trim();
  if (tldrText) {
    summary = tldrText;
    source = "s2-tldr";
  } else {
    let abstract: string | undefined = (s2?.abstract ?? entry.fields.abstract)?.trim();
    let title = s2?.title ?? entry.fields.title ?? citeKey;
    if (!abstract) {
      // S2 gave nothing (rate-limited, unreachable, or no record) — OpenAlex
      // is a second, keyless index with its own abstract before giving up.
      openAlex = await resolveOpenAlexPaper(entry).catch(() => null);
      abstract = openAlex?.abstract?.trim();
      if (openAlex?.title) title = openAlex.title;
    }
    if (!abstract) throw rateLimited ?? new Error("no abstract available");
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
    oaPdfUrl: oaPdfUrlFor(entry, s2) ?? openAlex?.oaUrl ?? stored?.oaPdfUrl,
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
  // Still nothing (S2 rate-limited/no OA link, and the paper isn't on arXiv
  // either) — OpenAlex is a second, keyless index worth a try before giving up.
  if (candidates.size === 0) {
    const openAlex = await resolveOpenAlexPaper(entry).catch(() => null);
    if (openAlex?.oaUrl) {
      candidates.add(openAlex.oaUrl);
      writePaperRecord(projectId, citeKey, { oaPdfUrl: openAlex.oaUrl });
    }
  }
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

// ---- Claim verification -----------------------------------------------------
// auditEntry/auditCitations below only confirm a reference is real (the
// identifier resolves, the title matches) — they say nothing about whether
// the paper actually supports whatever it is cited for. This reads the
// paper's own content and asks.

export type CitationVerdict = "supported" | "partially_supported" | "not_supported" | "unclear";

export interface CitationCheckResult {
  verdict: CitationVerdict;
  explanation: string;
  /** Whether the check read the full paper or fell back to its abstract. */
  basis: "full_text" | "abstract";
}

/** Prompt + response are both capped — a 40-page paper must not blow the context. */
const MAX_VERIFY_CHARS = 60_000;

type Judge = (prompt: string) => Promise<string>;

/** Default judge: a one-shot agent call (lazy import keeps tests light, mirrors agentSummarize). */
async function defaultJudge(prompt: string): Promise<string> {
  const { runOneShot } = await import("./agent.js");
  return runOneShot(prompt);
}

/**
 * Extract page text via pdfjs-dist's Node-safe "legacy" build. Lazily
 * imported: it is a multi-MB module that only this verification path needs,
 * not the citation pipeline every request touches.
 */
async function extractPdfText(path: string): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push((content.items as any[]).map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  await doc.destroy();
  return pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
}

/** The model's first line is the verdict word; substring match tolerates "Verdict: X" prefixes. */
function parseVerdict(raw: string): { verdict: CitationVerdict; explanation: string } {
  const lines = raw.trim().split("\n").filter((l) => l.trim());
  const first = (lines[0] ?? "").toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_+|_+$/g, "");
  const explanation = lines.slice(1).join(" ").trim() || raw.trim();
  // NOT_SUPPORTED contains "SUPPORTED" as a substring, so check it (and the
  // other multi-word verdicts) before the plain one.
  if (first.includes("NOT_SUPPORTED") || first.includes("UNSUPPORTED") || first.includes("CONTRADICT")) {
    return { verdict: "not_supported", explanation };
  }
  if (first.includes("PARTIAL")) return { verdict: "partially_supported", explanation };
  if (first.includes("UNCLEAR") || first.includes("INSUFFICIENT")) return { verdict: "unclear", explanation };
  if (first.includes("SUPPORTED")) return { verdict: "supported", explanation };
  return { verdict: "unclear", explanation };
}

/**
 * Check whether a cited paper's own content backs a specific claim attributed
 * to it. Reads the cached open-access PDF when one can be fetched; falls back
 * to the abstract (the bib entry's own, else S2's, else OpenAlex's) when no
 * PDF is available. Never throws for a missing source — that case comes back
 * as an "unclear" verdict explaining why nothing could be checked.
 */
export async function verifyCitationSupport(
  projectId: string,
  projectPath: string,
  citeKey: string,
  claim: string,
  opts: { judge?: Judge } = {},
): Promise<CitationCheckResult> {
  const entry = findEntry(projectPath, citeKey);
  const title = entry.fields.title?.trim() || citeKey;

  let source: string | undefined;
  let basis: CitationCheckResult["basis"] = "abstract";
  try {
    const pdfPath = await ensurePaperPdf(projectId, projectPath, citeKey);
    const extracted = await extractPdfText(pdfPath);
    if (extracted) {
      source = extracted;
      basis = "full_text";
    }
  } catch {
    /* no open-access PDF, or extraction failed — fall back to the abstract */
  }

  if (!source) {
    let abstract: string | undefined = entry.fields.abstract?.trim();
    if (!abstract) abstract = (await resolveS2Paper(entry).catch(() => null))?.abstract?.trim();
    if (!abstract) abstract = (await resolveOpenAlexPaper(entry).catch(() => null))?.abstract?.trim();
    if (!abstract) {
      return {
        verdict: "unclear",
        explanation:
          "No open-access PDF or abstract could be found for this reference, so the claim could not be checked against its content.",
        basis: "abstract",
      };
    }
    source = abstract;
    basis = "abstract";
  }

  const clipped =
    source.length > MAX_VERIFY_CHARS ? `${source.slice(0, MAX_VERIFY_CHARS)}\n\n[…truncated…]` : source;
  const sourceLabel =
    basis === "full_text"
      ? "the full text of the cited paper (extracted from its PDF)"
      : "the abstract only — the full paper text was not available";

  const prompt =
    `You fact-check citations in a research paper. Below is ${sourceLabel} of a paper titled "${title}".\n\n` +
    `${clipped}\n\n---\n\n` +
    `Claim the citing paper attributes to this work: "${claim}"\n\n` +
    "Does the text above actually support this claim? Reply with exactly one verdict word on the first line — " +
    "SUPPORTED, PARTIALLY_SUPPORTED, NOT_SUPPORTED, or UNCLEAR (only if the text truly lacks enough information to " +
    "judge) — then one or two sentences of justification on the next line, quoting or pointing to the specific part " +
    "of the text that supports or contradicts the claim when you can.";
  const raw = await (opts.judge ?? defaultJudge)(prompt);
  return { ...parseVerdict(raw), basis };
}

/** Agent-facing report for a verify_citation_support call. */
export function formatCitationCheckResult(citeKey: string, claim: string, result: CitationCheckResult): string {
  const basisNote =
    result.basis === "full_text"
      ? "checked against the full paper text"
      : "checked against the abstract only — the full paper was not available";
  const lines = [
    `Claim: "${claim}"`,
    `\\cite{${citeKey}}: ${result.verdict.toUpperCase().replace(/_/g, " ")} (${basisNote})`,
    result.explanation,
  ];
  if (result.verdict === "not_supported" || result.verdict === "unclear") {
    lines.push(
      "Do not leave this as-is: find a better source, adjust the claim to match what the paper actually says, or tell the user this citation could not be verified.",
    );
  } else if (result.verdict === "partially_supported") {
    lines.push("Consider narrowing the claim so it matches exactly what the paper supports.");
  }
  return lines.join("\n");
}

// ---- Deterministic citation audit ------------------------------------------

export type AuditStatus = "verified" | "mismatch" | "unresolved" | "skipped";

export interface AuditResult {
  status: AuditStatus;
  /** Human explanation — e.g. both titles on a mismatch. */
  detail?: string;
  /** Evidence link (doi.org / OpenAlex / arXiv) when available. */
  url?: string;
  /** The user judged this entry sound despite the audit — see `fingerprint`. */
  accepted?: boolean;
  /** Entry state when it was accepted; editing the entry retires the acceptance. */
  fingerprint?: string;
}

/**
 * Identity of an entry's checkable content. An acceptance is tied to this, so
 * changing the title or DOI silently re-opens the entry to auditing instead of
 * carrying a stale "you said this was fine" forever.
 */
export function entryFingerprint(entry: BibEntry): string {
  return `${normTitle(entry.fields.title ?? "")}|${(entryDoi(entry.fields) ?? "").toLowerCase()}`;
}

/** The persisted outcome of the last audit run for a project. */
export interface CitationAudit {
  at: string;
  results: Record<string, AuditResult>;
}

const auditPath = (projectId: string) => join(papersDir(), `${projectId}.audit.json`);

export function readAudit(projectId: string): CitationAudit | null {
  try {
    return JSON.parse(readFileSync(auditPath(projectId), "utf8")) as CitationAudit;
  } catch {
    return null;
  }
}

function writeAudit(projectId: string, audit: CitationAudit): void {
  mkdirSync(papersDir(), { recursive: true });
  writeFileSync(auditPath(projectId), JSON.stringify(audit, null, 2));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Evidence link for a search hit: DOI → OpenAlex work page → arXiv abstract. */
function auditHitUrl(hit: PaperHit): string | undefined {
  if (hit.doi) return `https://doi.org/${hit.doi}`;
  const openalex = /^openalex:(W\w+)$/i.exec(hit.ref);
  if (openalex) return `https://openalex.org/${openalex[1]}`;
  const arxiv = /^arxiv:(.+)$/i.exec(hit.ref);
  if (arxiv) return `https://arxiv.org/abs/${arxiv[1]}`;
  return undefined;
}

/**
 * Every way a record may render its title. Crossref splits many titles across
 * `title` and `subtitle` ("AMIE" + "association rule mining under incomplete
 * evidence…"), so comparing against `title[0]` alone flags correct entries as
 * mismatches.
 */
export function titleCandidates(msg: any): string[] {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const titles = list(msg?.title);
  const subtitles = list(msg?.subtitle);
  const out = new Set<string>();
  for (const t of [...titles, ...list(msg?.["original-title"])]) {
    out.add(t);
    for (const s of subtitles) out.add(`${t}: ${s}`);
  }
  if (titles.length > 1) out.add(titles.join(" "));
  return [...out];
}

/** Share of the shorter title's words that also appear in the other. */
function titleOverlap(a: string, b: string): number {
  const wa = new Set(normTitle(a).split(" ").filter(Boolean));
  const wb = new Set(normTitle(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

/** Normalized word-boundary containment — a short official title inside a fuller one. */
function titleContains(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb || na.length < 4 || nb.length < 4) return false;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return long === short || long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `);
}

/** First author's surname as written in a BibTeX author field ("Last, First and …"). */
function firstAuthorSurname(author: string | undefined): string | undefined {
  const first = author?.split(/\s+and\s+/i)[0]?.trim();
  if (!first) return undefined;
  const surname = first.includes(",") ? first.split(",")[0] : first.split(/\s+/).at(-1);
  return surname?.replace(/[{}]/g, "").trim().toLowerCase() || undefined;
}

/** The publication year a Crossref record reports, from whichever date it carries. */
function crossrefYear(msg: any): string | undefined {
  for (const field of ["issued", "published-print", "published-online", "published"]) {
    const y = msg?.[field]?.["date-parts"]?.[0]?.[0];
    if (typeof y === "number") return String(y);
  }
  return undefined;
}

export interface EntryFacts {
  title?: string;
  author?: string;
  year?: string;
}

/**
 * Decide whether a resolved record is the work the entry describes. A DOI that
 * resolves is already strong evidence — the title check only guards against a
 * mistyped identifier pointing at a *different* paper, so it accepts the many
 * legitimate ways the same title is recorded (split subtitles, short forms) and
 * falls back to author+year corroboration before crying mismatch.
 */
export function matchesRecord(
  entry: EntryFacts,
  candidates: string[],
  record: { author?: string; year?: string } = {},
): { ok: boolean; note?: string } {
  const title = entry.title?.trim();
  if (!title || candidates.length === 0) return { ok: true, note: "no title to compare" };
  if (candidates.some((c) => titlesSimilar(title, c))) return { ok: true };
  if (candidates.some((c) => titleContains(title, c))) {
    return { ok: true, note: "the record splits or shortens the title" };
  }
  const surname = firstAuthorSurname(entry.author);
  const sameAuthor = Boolean(surname && record.author && record.author.toLowerCase().includes(surname));
  const sameYear = Boolean(entry.year && record.year && entry.year.trim() === record.year);
  // Author+year alone is NOT enough: a mistyped identifier often lands on
  // another paper by the same authors in the same year. Require the titles to
  // be at least related before accepting a differently-written one.
  if (sameAuthor && sameYear && candidates.some((c) => titleOverlap(title, c) >= 0.34)) {
    return { ok: true, note: "the record's title is written differently, but author and year match" };
  }
  return { ok: false };
}

/** Check a DOI against Crossref and compare titles. */
/**
 * arXiv's own DOI namespace. Crossref does not index these at all (they are
 * registered with DataCite), so a Crossref lookup 404s on a perfectly real
 * preprint — which is why the audit must ask arXiv directly instead of
 * reporting the entry as unfindable.
 */
export function arxivIdFromDoi(doi: string): string | undefined {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi.trim());
  return m ? m[1] : undefined;
}

/** Check an arXiv id against arXiv's own API and compare titles. */
async function auditByArxiv(arxivId: string, entry: EntryFacts): Promise<AuditResult> {
  const bare = arxivId.replace(/v\d+$/i, "");
  const evidence = `https://arxiv.org/abs/${bare}`;
  let xml: string;
  try {
    const res = await fetch(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}&max_results=1`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return { status: "skipped", detail: `arXiv: HTTP ${res.status}` };
    xml = await res.text();
  } catch (err: any) {
    return { status: "skipped", detail: `arXiv unreachable: ${err?.message ?? err}` };
  }
  const body = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  const remoteTitle = body
    ? /<title>([\s\S]*?)<\/title>/.exec(body)?.[1].replace(/\s+/g, " ").trim()
    : undefined;
  // A withdrawn or non-existent id yields a feed whose single entry is titled
  // "Error" — that is arXiv saying "no such paper", not a title mismatch.
  if (!body || !remoteTitle || /^error$/i.test(remoteTitle)) {
    return { status: "unresolved", detail: `arXiv has no record for ${bare}` };
  }
  if (!entry.title) return { status: "verified", detail: "arXiv id resolves (no title to compare)", url: evidence };
  const authors = [...body.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).join(" ");
  const year = /<published>(\d{4})/.exec(body)?.[1];
  const match = matchesRecord(entry, [remoteTitle], { author: authors, year });
  if (match.ok) {
    return { status: "verified", detail: match.note ?? "verified on arXiv", url: evidence };
  }
  return {
    status: "mismatch",
    detail: `entry title "${entry.title}" vs arXiv "${remoteTitle}"`,
    url: evidence,
  };
}

async function auditByDoi(doi: string, entry: EntryFacts): Promise<AuditResult> {
  const title = entry.title;
  const evidence = `https://doi.org/${doi}`;
  let data: any;
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi).replace(/%2F/g, "/")}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { status: "unresolved", detail: `DOI ${doi} not found on Crossref` };
    if (!res.ok) return { status: "skipped", detail: `Crossref: HTTP ${res.status}` };
    data = await res.json();
  } catch (err: any) {
    return { status: "skipped", detail: `Crossref unreachable: ${err?.message ?? err}` };
  }
  const msg = data?.message;
  const candidates = titleCandidates(msg);
  if (candidates.length === 0 || !title) {
    return { status: "verified", detail: "DOI resolves (no title to compare)", url: evidence };
  }
  const authors = Array.isArray(msg?.author)
    ? msg.author.map((a: any) => `${a?.family ?? ""} ${a?.given ?? ""}`).join(" ")
    : undefined;
  const match = matchesRecord(entry, candidates, { author: authors, year: crossrefYear(msg) });
  if (match.ok) {
    return { status: "verified", detail: match.note, url: evidence };
  }
  // The fullest candidate is the most informative thing to show the user.
  const shown = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  return {
    status: "mismatch",
    detail: `entry title "${title}" vs Crossref "${shown}"`,
    url: evidence,
  };
}

/** Look a title up on OpenAlex, then Crossref (same tolerant comparison). */
/**
 * Search every index BlattBot knows for a matching title. Crossref alone is
 * not enough — it misses the ML venues (NeurIPS, ICML, ICLR) and preprints
 * where a lot of the literature lives, which is the same reason paper search
 * queries four sources. The matching source is reported so the user can see
 * WHERE a reference was confirmed.
 */
async function auditByTitle(entry: EntryFacts): Promise<AuditResult> {
  const title = entry.title!;
  const accepts = (hit: PaperHit) =>
    matchesRecord(entry, [hit.title], { author: hit.authors, year: hit.year ? String(hit.year) : undefined }).ok;
  let hits: PaperHit[];
  try {
    // searchPapers merges Semantic Scholar, DBLP, Crossref, and OpenAlex, and
    // already tolerates individual sources failing.
    hits = await searchPapers(title, 8);
  } catch (err: any) {
    return { status: "skipped", detail: `title lookup unavailable: ${err?.message ?? err}` };
  }
  const hit = hits.find(accepts);
  if (hit) {
    return { status: "verified", detail: `matched on ${hit.source}`, url: auditHitUrl(hit) };
  }
  // No hit from indexes that DID answer means "not found" — searchPapers
  // throws (handled above) when every source failed.
  return {
    status: "unresolved",
    detail: "no record with a matching title on Semantic Scholar, DBLP, Crossref, or OpenAlex",
  };
}

/**
 * Audit one entry. The order matters: an arXiv id is checked against arXiv
 * itself (Crossref does not index the 10.48550 namespace), a DOI against
 * Crossref, and anything the identifier route cannot confirm falls through to
 * a multi-index title search before the entry is called unresolved. A
 * `mismatch` is authoritative and never softened by a later lookup — it means
 * the identifier resolves to a different work.
 */
export async function auditEntry(entry: BibEntry): Promise<AuditResult> {
  const doi = entryDoi(entry.fields);
  const facts: EntryFacts = {
    title: entry.fields.title?.trim(),
    author: entry.fields.author,
    year: entry.fields.year,
  };
  const arxivId = arxivIdFromEntry(entry);
  let first: AuditResult | undefined;

  if (arxivId) {
    first = await auditByArxiv(arxivId, facts);
  } else if (doi) {
    first = await auditByDoi(doi, facts);
  }
  // Verified or contradicted — done. Otherwise the identifier simply is not in
  // that index, which is routine for preprints and CS proceedings.
  if (first && (first.status === "verified" || first.status === "mismatch")) return first;

  if (facts.title) {
    const byTitle = await auditByTitle(facts);
    if (byTitle.status === "verified" && first) {
      const where = doi ? `${doi} is not indexed there` : "the identifier lookup found nothing";
      return { ...byTitle, detail: `${where}, but the record ${byTitle.detail ?? "matched by title"}` };
    }
    // A network failure on the identifier route should not masquerade as
    // "no such paper" just because the title search also came up empty.
    if (byTitle.status === "unresolved" && first?.status === "skipped") return first;
    return byTitle;
  }
  return first ?? { status: "unresolved", detail: "entry has no DOI or title to check" };
}

/**
 * Merge fresh results into the stored audit, keeping every other entry's
 * verdict. Lets a single added/repaired reference update its badge without
 * re-checking (and re-hammering the public APIs for) the whole bibliography.
 */
export function recordAuditResults(projectId: string, results: Record<string, AuditResult>): CitationAudit {
  const prev = readAudit(projectId);
  const merged: CitationAudit = {
    at: new Date().toISOString(),
    results: { ...(prev?.results ?? {}), ...results },
  };
  writeAudit(projectId, merged);
  return merged;
}

/**
 * Check specific bib entries (all of them when `keys` is omitted) and persist
 * the verdicts. Unknown keys are reported so a caller — the agent verifying a
 * reference it just wrote by hand — learns the entry is not in the .bib at all.
 */
export async function auditEntries(
  projectId: string,
  projectPath: string,
  keys?: string[],
  opts: { delayMs?: number } = {},
): Promise<{ results: Record<string, AuditResult>; unknownKeys: string[] }> {
  const delayMs = opts.delayMs ?? 200;
  const all = readAllBibEntries(projectPath);
  const wanted = keys && keys.length > 0 ? keys : all.map((x) => x.entry.key);
  const byKey = new Map(all.map((x) => [x.entry.key, x.entry]));
  const results: Record<string, AuditResult> = {};
  const unknownKeys: string[] = [];
  let checked = 0;
  for (const key of wanted) {
    const entry = byKey.get(key);
    if (!entry) {
      unknownKeys.push(key);
      continue;
    }
    // An entry the user accepted stays accepted while it is unchanged — no
    // lookup, and no re-flagging of a verdict they already judged wrong.
    const prior = readAudit(projectId)?.results[key];
    if (prior?.accepted && prior.fingerprint === entryFingerprint(entry)) {
      results[key] = prior;
      continue;
    }
    if (checked > 0 && delayMs > 0) await sleep(delayMs);
    checked++;
    try {
      results[key] = await auditEntry(entry);
    } catch (err: any) {
      results[key] = { status: "skipped", detail: String(err?.message ?? err) };
    }
  }
  if (Object.keys(results).length > 0) recordAuditResults(projectId, results);
  return { results, unknownKeys };
}

/** Agent-facing report for an audit_citations run. */
export function formatAuditReport(
  results: Record<string, AuditResult>,
  unknownKeys: string[] = [],
): string {
  const lines: string[] = [];
  const order: AuditStatus[] = ["mismatch", "unresolved", "skipped", "verified"];
  const counts = { verified: 0, mismatch: 0, unresolved: 0, skipped: 0 };
  for (const r of Object.values(results)) counts[r.status]++;
  lines.push(
    `Checked ${Object.keys(results).length} entr${Object.keys(results).length === 1 ? "y" : "ies"}: ` +
      `${counts.verified} verified, ${counts.mismatch} mismatch, ${counts.unresolved} unresolved, ${counts.skipped} skipped.`,
  );
  for (const status of order) {
    for (const [key, r] of Object.entries(results)) {
      if (r.status !== status) continue;
      const detail = r.detail ? ` — ${r.detail}` : "";
      const url = r.url ? ` (${r.url})` : "";
      lines.push(`  ${status.toUpperCase()} \\cite{${key}}${detail}${url}`);
    }
  }
  if (unknownKeys.length > 0) {
    lines.push(`Not found in any .bib file: ${unknownKeys.join(", ")} — check the key spelling.`);
  }
  if (counts.mismatch > 0 || counts.unresolved > 0) {
    lines.push(
      "Fix or remove the flagged entries, or tell the user they could not be verified — never leave an unverified reference unmentioned.",
    );
  }
  return lines.join("\n");
}

/**
 * Record the user's judgement that a flagged entry is sound (the audit's
 * checks are heuristic — a correct reference can still fail them). Tied to the
 * entry's current content, so a later edit puts it back under scrutiny.
 */
export function acceptAuditEntry(projectId: string, projectPath: string, key: string): AuditResult {
  const entry = readAllBibEntries(projectPath).find((x) => x.entry.key === key)?.entry;
  if (!entry) throw new Error(`unknown citation key: ${key}`);
  const prior = readAudit(projectId)?.results[key];
  const result: AuditResult = {
    status: "verified",
    detail: `accepted by you${prior && prior.status !== "verified" ? ` (audit said: ${prior.status})` : ""}`,
    url: prior?.url,
    accepted: true,
    fingerprint: entryFingerprint(entry),
  };
  recordAuditResults(projectId, { [key]: result });
  return result;
}

/**
 * Verify a single entry right after it was written, so a bad reference is
 * caught while the agent can still act on it. Never throws: a verification
 * failure must not undo a citation that was added successfully.
 */
export async function verifyEntry(
  projectId: string | undefined,
  projectPath: string,
  key: string,
): Promise<AuditResult | undefined> {
  try {
    const entry = readAllBibEntries(projectPath).find((x) => x.entry.key === key)?.entry;
    if (!entry) return undefined;
    const result = await auditEntry(entry);
    if (projectId) recordAuditResults(projectId, { [key]: result });
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic citation audit — no LLM involved. Each bib entry is checked
 * against Crossref (by DOI) or OpenAlex/Crossref (by title search):
 * `verified` = the reference resolves and the titles agree, `mismatch` = it
 * resolves to a clearly different title, `unresolved` = no record found,
 * `skipped` = a network failure prevented the check (NOT the same thing).
 * Entries run sequentially with a small delay — polite to the public APIs.
 * The outcome is persisted so badges survive reloads.
 */
export async function auditCitations(
  projectId: string,
  projectPath: string,
  opts: { delayMs?: number } = {},
): Promise<CitationAudit> {
  const delayMs = opts.delayMs ?? 200;
  const all = readAllBibEntries(projectPath);
  const results: Record<string, AuditResult> = {};
  for (let i = 0; i < all.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const { entry } = all[i];
    try {
      results[entry.key] = await auditEntry(entry);
    } catch (err: any) {
      // allSettled semantics: one entry's failure never sinks the audit.
      results[entry.key] = { status: "skipped", detail: String(err?.message ?? err) };
    }
  }
  const audit: CitationAudit = { at: new Date().toISOString(), results };
  writeAudit(projectId, audit);
  return audit;
}
