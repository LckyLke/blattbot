/**
 * The search_files tool: literal or regex text search across the project
 * working tree, or across one attached read-only context directory.
 *
 * Path safety is read_file's: the optional path prefix and every candidate
 * file go through resolveReadPath. Candidates come from listFiles, the same
 * walk list_files uses, which skips dot-entries (so .git is never searched),
 * node_modules and symlinks. Binaries and files over the read_file size cap are
 * skipped and counted. Matching runs line by line inside a vm with a timeout,
 * so a pathological regular expression ends with an error instead of blocking
 * the server.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import vm from "node:vm";
import { listFiles } from "../latex.js";
import { displayPath, isInside, resolveReadPath } from "./paths.js";

export interface SearchFilesOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Project-relative path prefix, or an absolute path inside an attached context directory. */
  path?: string;
  contextLines?: number;
  limit?: number;
}

export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_MAX_CONTEXT_LINES = 10;
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_LINE_CHARS = 300;
const MAX_OUTPUT_CHARS = 60_000;
const MATCH_TIMEOUT_MS = 3000;

/** Runs inside the vm: one pass over every line, so one timeout bounds it. */
const MATCH_SCRIPT = new vm.Script(`(() => {
  const hits = [];
  let total = 0;
  for (let f = 0; f < files.length; f++) {
    const lines = files[f];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        total++;
        if (hits.length < cap * 2) hits.push(f, i);
      }
    }
  }
  return { hits, total };
})()`);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS - 1) + "…" : line;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Search and format the result as plain text in grep's shape:
 * `path:LINE:text` for matching lines, `path-LINE-text` for context lines,
 * `--` between separate excerpts. Throws on invalid input or a blocked path.
 */
export function searchFiles(
  dir: string,
  contextDirs: string[],
  opts: SearchFilesOptions,
  { maxFileBytes, signal, timeoutMs = MATCH_TIMEOUT_MS }: { maxFileBytes: number; signal?: AbortSignal; timeoutMs?: number },
): string {
  const query = opts.query;
  if (typeof query !== "string" || !query) throw new Error("query is required");
  if (/[\r\n]/.test(query)) throw new Error("query must be a single line: files are matched line by line");
  const regex = opts.regex === true;
  const caseSensitive = opts.caseSensitive === true;
  const contextLines = opts.contextLines ?? 0;
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  let re: RegExp;
  try {
    re = new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? "" : "i");
  } catch (e: any) {
    throw new Error(`invalid regular expression: ${e?.message ?? e}`);
  }

  // Scope: the whole project, or the files under one validated path prefix.
  let root = dir;
  let candidates: string[];
  if (opts.path !== undefined && opts.path.trim()) {
    const abs = resolveReadPath(dir, contextDirs, opts.path);
    root = isInside(abs, dir) ? dir : contextDirs.find((c) => isInside(abs, c))!;
    let single = false;
    try { single = lstatSync(abs).isFile(); } catch { /* a prefix, not a file */ }
    const rel = relative(root, abs).split(sep).join("/");
    if (single) candidates = [rel];
    else {
      const prefix = rel && /[\\/]$/.test(opts.path.trim()) ? `${rel}/` : rel;
      candidates = listFiles(root).filter((f) => f.startsWith(prefix));
    }
  } else {
    candidates = listFiles(dir);
  }

  const names: string[] = [];
  const files: string[][] = [];
  let skippedBinary = 0;
  let skippedLarge = 0;
  let scannedBytes = 0;
  let capped = false;
  for (const rel of candidates) {
    signal?.throwIfAborted();
    if (names.length >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) { capped = true; break; }
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      // The same fence read_file applies, for every file the walk produced.
      resolveReadPath(dir, contextDirs, abs);
      const st = lstatSync(abs);
      if (!st.isFile()) continue;
      if (st.size > maxFileBytes) { skippedLarge++; continue; }
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (rel.toLowerCase().endsWith(".pdf") || buf.includes(0)) { skippedBinary++; continue; }
    scannedBytes += buf.length;
    names.push(displayPath(dir, abs));
    files.push(buf.toString("utf8").split(/\r?\n/));
  }

  let found: { hits: number[]; total: number };
  try {
    found = MATCH_SCRIPT.runInNewContext({ files, re, cap: limit }, { timeout: timeoutMs });
  } catch (e: any) {
    if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error("the search timed out — simplify the regular expression or narrow the path");
    }
    throw e;
  }

  const describe = `${regex ? "regex" : "literal"}, ${caseSensitive ? "case-sensitive" : "case-insensitive"}`;
  const notes: string[] = [];
  if (skippedBinary || skippedLarge) {
    notes.push(`Skipped ${plural(skippedBinary, "binary file")} and ${plural(skippedLarge, "file")} over ${Math.round(maxFileBytes / 1024)} KB (use read_file for PDFs).`);
  }
  if (capped) notes.push(`Stopped after ${plural(names.length, "file")}; narrow the search with path.`);
  if (found.total === 0) {
    return [`No matches for ${JSON.stringify(query)} (${describe}) in ${plural(names.length, "file")}.`, ...notes].join("\n");
  }

  // Group the hits per file, then merge overlapping context windows.
  const byFile = new Map<number, number[]>();
  for (let k = 0; k < found.hits.length; k += 2) {
    const list = byFile.get(found.hits[k]) ?? [];
    list.push(found.hits[k + 1]);
    byFile.set(found.hits[k], list);
  }
  const shown = found.hits.length / 2;
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  emit: for (const [f, hitLines] of byFile) {
    const lines = files[f];
    const hitSet = new Set(hitLines);
    let last = -2;
    for (const hit of hitLines) {
      const from = Math.max(0, hit - contextLines, last + 1);
      const to = Math.min(lines.length - 1, hit + contextLines);
      if (out.length && from > last + 1) out.push("--");
      for (let i = from; i <= to; i++) {
        const line = `${names[f]}${hitSet.has(i) ? ":" : "-"}${i + 1}${hitSet.has(i) ? ":" : "-"}${clipLine(lines[i])}`;
        size += line.length + 1;
        if (size > MAX_OUTPUT_CHARS) { truncated = true; break emit; }
        out.push(line);
      }
      last = Math.max(last, to);
    }
  }
  const header = `${plural(found.total, "matching line")} for ${JSON.stringify(query)} (${describe}) across ${plural(names.length, "searched file")}:`;
  if (found.total > shown) notes.push(`Showing the first ${shown}; narrow query or path, or raise limit (max ${SEARCH_MAX_LIMIT}).`);
  if (truncated) notes.push(`Output truncated at ${MAX_OUTPUT_CHARS} characters; narrow the search or use fewer contextLines.`);
  return [header, ...out, ...(notes.length ? ["", ...notes] : [])].join("\n");
}
