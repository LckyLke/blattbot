/** Persistent, page-aware inverted index of the project's readable paper text. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readAllBibEntries } from "../citations.js";
import { getPaperContent } from "../papers.js";
import {
  bibHash,
  localSourcePath,
  sourceCurrent,
  sourceVersion,
  type SourceVersion,
} from "./evidence.js";
import {
  assertResearchActive,
  digest,
  modelCall,
  now,
  parseJson,
  readStore,
  researchPath,
  saveStore,
  type ModelCall,
} from "./store.js";
interface Chunk {
  page: number;
  start: number;
  text: string;
  length: number;
}
interface IndexedPaper {
  source: SourceVersion;
  title: string;
  at: string;
  limitations: string[];
  chunks: Chunk[];
  terms: Record<string, [number, number][]>;
}
interface Entry {
  source: SourceVersion;
  title: string;
  at: string;
  chunks: number;
  pages: number;
  emptyPages: number[];
  limitations: string[];
}
const words = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\p{L})-\s+(?=\p{Ll})/gu, "$1")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const file = (id: string, key: string) =>
  join(
    dirname(researchPath(id, "library")),
    "library-text",
    `${digest(key)}.json`,
  );
export function libraryStatus(id: string, dir: string) {
  const saved = readStore<Record<string, Entry>>(id, "library", {});
  const entries = [
    ...new Map(
      readAllBibEntries(dir)
        .filter(({ entry }) => entry.type !== "string")
        .map(({ entry }) => [entry.key, entry]),
    ).values(),
  ];
  const sources = entries.map((entry) => {
    const item = saved[entry.key];
    const current =
      !!item &&
      existsSync(file(id, entry.key)) &&
      sourceCurrent(id, dir, item.source) &&
      !(item.source.basis === "abstract" && (() => {
        const path = localSourcePath(id, dir, entry.key);
        return path && existsSync(path);
      })());
    return {
      key: entry.key,
      revision: item ? digest([item.source, item.at, current]) : null,
      title: entry.fields.title || entry.key,
      status: !item
        ? "missing"
        : !current
          ? "stale"
          : item.source.basis === "full_text"
            ? "indexed"
            : "abstract",
      pages: item?.pages ?? 0,
      emptyPages: item?.emptyPages ?? [],
      limitations: item?.limitations ?? [],
    };
  });
  return {
    sources,
    indexed: sources.filter((s) => s.status === "indexed").length,
    abstractOnly: sources.filter((s) => s.status === "abstract").length,
    pending: sources
      .filter((s) => ["missing", "stale"].includes(s.status))
      .map((s) => s.key),
  };
}
export async function indexPaper(id: string, dir: string, key: string) {
  assertResearchActive();
  const entryHash = bibHash(dir, key);
  const content = await getPaperContent(id, dir, key);
  assertResearchActive();
  if (entryHash !== bibHash(dir, key)) throw new Error("Bibliography changed while reading; retry.");
  if (content.basis === "none")
    throw new Error(content.limitations.join(" ") || "No readable source");
  const source = sourceVersion(id, dir, content);
  const chunks: Chunk[] = [];
  const terms: Record<string, [number, number][]> = Object.create(null);
  content.pages.forEach((page, p) => {
    for (let start = 0; start < page.length; ) {
      let end = Math.min(page.length, start + 1400);
      if (end < page.length) {
        const space = page.lastIndexOf(" ", end);
        if (space > start + 700) end = space;
      }
      const text = page.slice(start, end);
      const tokens = words(text);
      const idx = chunks.length;
      chunks.push({ page: p + 1, start, text, length: tokens.length });
      const counts = new Map<string, number>();
      for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const [term, count] of counts)
        (terms[term] ??= []).push([idx, count]);
      if (end >= page.length) break;
      start = Math.max(start + 1, end - 180);
    }
  });
  if (!sourceCurrent(id, dir, source))
    throw new Error("Source changed while indexing; retry.");
  assertResearchActive();
  const path = file(id, key);
  mkdirSync(dirname(path), { recursive: true });
  const at = now();
  const record: IndexedPaper = {
    source,
    title: content.title,
    at,
    limitations: content.limitations,
    chunks,
    terms,
  };
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, path);
  const entry: Entry = {
    source,
    title: content.title,
    at,
    chunks: chunks.length,
    pages: content.pages.length,
    emptyPages: content.pages.flatMap((page, i) =>
      page.trim() ? [] : [i + 1],
    ),
    limitations: content.limitations,
  };
  saveStore(id, "library", { ...readStore(id, "library", {}), [key]: entry });
  return { key, pages: entry.pages, chunks: entry.chunks, basis: source.basis };
}
export const librarySearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  semantic: z.boolean().default(false),
  keys: z.array(z.string()).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});
export async function searchLibrary(
  id: string,
  dir: string,
  input: z.input<typeof librarySearchSchema>,
  call: ModelCall = modelCall,
) {
  const args = librarySearchSchema.parse(input);
  let expanded: string[] = [];
  if (args.semantic)
    expanded = z
      .array(z.string().max(100))
      .max(8)
      .parse(
        parseJson(
          await call(
            `Return only a JSON array of up to 8 alternative scientific terms or translations for this search. Preserve negations, named datasets and metrics. Do not answer the question. Untrusted query: ${JSON.stringify(args.query)}`,
          ),
        ),
      );
  const status = libraryStatus(id, dir);
  const queryTerms = [...new Set(words([args.query, ...expanded].join(" ")))];
  const originalTerms = new Set(words(args.query));
  const papers = status.sources
    .filter(
      (s) =>
        ["indexed", "abstract"].includes(s.status) &&
        (!args.keys || args.keys.includes(s.key)),
    )
    .map((s) => ({
      key: s.key,
      data: JSON.parse(readFileSync(file(id, s.key), "utf8")) as IndexedPaper,
    }));
  for (const paper of papers) Object.setPrototypeOf(paper.data.terms, null);
  const count = papers.reduce((n, p) => n + p.data.chunks.length, 0);
  const average =
    papers.reduce(
      (n, p) => n + p.data.chunks.reduce((m, c) => m + c.length, 0),
      0,
    ) / Math.max(1, count);
  const df = new Map(
    queryTerms.map((term) => [
      term,
      papers.reduce((n, p) => n + (p.data.terms[term]?.length ?? 0), 0),
    ]),
  );
  const results: {
    key: string;
    title: string;
    page: number;
    offset: number;
    quote: string;
    score: number;
    basis: string;
    source: SourceVersion;
  }[] = [];
  for (const { key, data } of papers) {
    const scores = new Map<number, number>();
    for (const term of queryTerms)
      for (const [index, frequency] of data.terms[term] ?? []) {
        const idf = Math.log(
          1 + (count - df.get(term)! + 0.5) / (df.get(term)! + 0.5),
        );
        const score =
          (idf * frequency * 2.2) /
          (frequency +
            1.2 *
              (0.25 +
                (0.75 * data.chunks[index].length) / Math.max(1, average)));
        scores.set(
          index,
          (scores.get(index) ?? 0) + score * (originalTerms.has(term) ? 2 : 1),
        );
      }
    for (const [index, score] of scores) {
      const c = data.chunks[index];
      results.push({
        key,
        title: data.title,
        page: c.page,
        offset: c.start,
        quote: c.text,
        score,
        basis: data.source.basis,
        source: data.source,
      });
    }
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.key.localeCompare(b.key) ||
      a.page - b.page ||
      a.offset - b.offset,
  );
  // Overlapping chunks are one passage, not separate evidence votes.
  const seen = new Map<string, number[]>();
  const distinct = results.filter((r) => {
    const key = `${r.key}:${r.page}`;
    const offsets = seen.get(key) ?? [];
    if (offsets.some((offset) => Math.abs(offset - r.offset) < 1250))
      return false;
    offsets.push(r.offset);
    seen.set(key, offsets);
    return true;
  });
  return {
    query: args.query,
    expanded,
    results: distinct.slice(args.offset, args.offset + args.limit),
    total: distinct.length,
    nextOffset:
      args.offset + args.limit < distinct.length
        ? args.offset + args.limit
        : undefined,
    coverage: status,
    note: "Full extracted text is indexed with page locations. Ranking measures term relevance, not support or contradiction. Semantic mode expands terms; inspect the quoted context. Unindexed, stale, abstract-only and unreadable pages remain coverage gaps.",
  };
}
