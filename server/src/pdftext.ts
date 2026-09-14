/** Shared PDF text reader for paper tools and uploaded context. */
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { assertResearchActive, researchSignal } from "./research/store.js";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
const cache = new Map<string, string[]>();
const pdfHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ocrPath = (hash: string) => join(DATA_DIR, "paper-ocr", `${hash}.json`);
function ocrText(hash: string): Record<string, string> {
  return existsSync(ocrPath(hash)) ? JSON.parse(readFileSync(ocrPath(hash), "utf8")) : {};
}
export function pdfTextRevision(path: string): string {
  return createHash("sha256").update(JSON.stringify(ocrText(pdfHash(path)))).digest("hex");
}
function withOcr(pages: string[], hash: string): string[] {
  const recognized = ocrText(hash);
  return pages.map((page, i) => recognized[i + 1] ? `${page}\n[OCR transcription — may contain recognition errors]\n${recognized[i + 1]}`.trim() : page);
}

export async function extractPdfPages(path: string, opts: { ocrPages?: number[] } = {}): Promise<string[]> {
  assertResearchActive();
  if (opts.ocrPages?.length) {
    const pages = await extractPdfPages(path);
    const hash = pdfHash(path);
    const { ocrPdfPage } = await import("./research/pdfreading.js");
    for (const page of [...new Set(opts.ocrPages)].slice(0, 3)) {
      if (page < 1 || page > pages.length) throw new Error("OCR page is outside the document");
      // Preserve existing text; OCR is needed for scanned pages and requested image tables.
      const recognized = await ocrPdfPage(path, page);
      assertResearchActive();
      if (recognized) {
        const next = { ...ocrText(hash), [page]: recognized };
        mkdirSync(join(DATA_DIR, "paper-ocr"), { recursive: true });
        const temp = `${ocrPath(hash)}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
        renameSync(temp, ocrPath(hash));
      }
    }
    return extractPdfPages(path);
  }
  if (statSync(path).size > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25 MB reading limit");
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("not a PDF file");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cached = cache.get(hash);
  if (cached) return withOcr(cached, hash);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  assertResearchActive();
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
  const signal = researchSignal();
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const pages: string[] = [];
  try {
    const doc = await loading.promise;
    assertResearchActive();
    if (doc.numPages > 1000) throw new Error("PDF exceeds the 1000-page reading limit; attach the relevant pages");
    let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      assertResearchActive();
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      chars += text.length;
      if (chars > 5_000_000) throw new Error("PDF text exceeds the reading limit; attach the relevant pages");
      pages.push(text);
      page.cleanup();
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await loading.destroy();
  }
  assertResearchActive();
  // Content-addressed: edits to an uploaded PDF cannot reuse stale text.
  if (pdfHash(path) !== hash) throw new Error("PDF changed during text extraction; retry with the current source");
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(hash, pages);
  return withOcr(pages, hash);
}

export interface TextReadOptions {
  offset?: number;
  limit?: number;
  query?: string;
}

export interface TextExcerpt {
  text: string;
  hasText: boolean;
  totalChars: number;
  nextOffset?: number;
  /** False for search excerpts and for a paginated part of a document. */
  complete: boolean;
}

/** Stable character offsets allow reads and searches beyond the first context window. */
export function readTextPages(pages: string[], opts: TextReadOptions = {}): TextExcerpt {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 20_000;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 100 || limit > 40_000) throw new Error("limit must be an integer between 100 and 40000");
  if (opts.query !== undefined && (typeof opts.query !== "string" || !opts.query.trim() || opts.query.length > 1000)) throw new Error("query must be non-empty text of at most 1000 characters");
  const starts: number[] = [];
  let document = "";
  pages.forEach((page, i) => {
    starts.push(document.length);
    document += `[Page ${i + 1}]\n${page || "[No extractable text on this page]"}\n\n`;
  });
  const pageAt = (pos: number) => starts.filter((start) => start <= pos).length;
  if (offset > document.length) throw new Error(`offset exceeds document length (${document.length})`);
  if (opts.query) {
    const query = opts.query.trim().toLowerCase();
    const lower = document.toLowerCase();
    const hits: string[] = [];
    let cursor = offset;
    let used = 0;
    while (hits.length < 5) {
      const hit = lower.indexOf(query, cursor);
      if (hit === -1) break;
      const available = limit - used - (hits.length ? 7 : 0);
      if (available < 100) break;
      const start = Math.max(0, hit - Math.min(250, Math.floor((available - 60) / 4)));
      const label = `Page ${pageAt(hit)}, offset ${start}:\n`;
      const end = Math.min(document.length, start + Math.min(1250, available - label.length));
      const excerpt = label + document.slice(start, end);
      hits.push(excerpt);
      used += excerpt.length;
      cursor = hit + query.length;
    }
    const more = lower.indexOf(query, cursor) !== -1;
    return {
      text: hits.length ? hits.join("\n\n---\n\n") : "No exact text matches. Try another phrase or read the text; this does not establish that a claim is unsupported.",
      hasText: hits.length > 0,
      totalChars: document.length,
      nextOffset: more ? cursor : undefined,
      complete: false,
    };
  }
  const end = Math.min(document.length, offset + limit);
  return {
    text: `Excerpt starts on page ${pageAt(offset)}, offset ${offset}.\n${document.slice(offset, end)}`,
    hasText: offset < end,
    totalChars: document.length,
    nextOffset: end < document.length ? end : undefined,
    complete: offset === 0 && end === document.length,
  };
}

export function formatTextExcerpt(excerpt: TextExcerpt): string {
  return `${excerpt.text}\n\n${excerpt.complete ? "All extracted text returned." : "Excerpt only; do not describe this as the entire paper having been read."}` +
    ` Total characters: ${excerpt.totalChars}.` +
    (excerpt.nextOffset !== undefined ? ` Continue with offset=${excerpt.nextOffset}.` : "");
}

export async function readPdfFile(path: string, opts: TextReadOptions = {}): Promise<string> {
  const pages = await extractPdfPages(path);
  if (!pages.some((page) => page.trim())) {
    return `NO READABLE TEXT: ${path}. The PDF may be scanned or image-only. Ask the user for an OCR/text version or the relevant passages; do not infer its contents.`;
  }
  const empty = pages.flatMap((page, i) => page.trim() ? [] : [i + 1]);
  return `PDF: ${path} (${pages.length} pages). Text extraction does not read figures or image-only tables.` +
    (empty.length ? ` No text on pages ${empty.join(", ")}; request those pages if needed.` : "") +
    `\n\n${formatTextExcerpt(readTextPages(pages, opts))}`;
}
