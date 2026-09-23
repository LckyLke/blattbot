import { LIBRARY_INDEX_VERSION, paperChunks, passageWindow, searchTerms, words, type PaperChunk } from "./library-text.js";
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
interface IndexedPaper {
  version: number;
  source: SourceVersion;
  title: string;
  at: string;
  limitations: string[];
  chunks: PaperChunk[];
  terms: Record<string, [number, number][]>;
}
interface Entry {
  version?: number;
  source: SourceVersion;
  title: string;
  at: string;
  chunks: number;
  pages: number;
  emptyPages: number[];
  limitations: string[];
}
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
      item.version === LIBRARY_INDEX_VERSION &&
      existsSync(file(id, entry.key)) &&
      sourceCurrent(id, dir, item.source) &&
      !(item.source.basis !== "full_text" && (() => {
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
            : item.source.basis === "summary" ? "summary" : "abstract",
      pages: item?.pages ?? 0,
      emptyPages: item?.emptyPages ?? [],
      limitations: item?.limitations ?? [],
    };
  });
  return {
    sources,
    indexed: sources.filter((s) => s.status === "indexed").length,
    abstractOnly: sources.filter((s) => s.status === "abstract").length,
    summaryOnly: sources.filter((s) => s.status === "summary").length,
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
  const chunks = paperChunks(content.pages);
  const terms: Record<string, [number, number][]> = Object.create(null);
  chunks.forEach((chunk, idx) => {
    const counts = new Map<string, number>();
    for (const term of words(chunk.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) (terms[term] ??= []).push([idx, count]);
  });
  if (!sourceCurrent(id, dir, source))
    throw new Error("Source changed while indexing; retry.");
  assertResearchActive();
  const path = file(id, key);
  mkdirSync(dirname(path), { recursive: true });
  const at = now();
  const record: IndexedPaper = {
    version: LIBRARY_INDEX_VERSION,
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
    version: LIBRARY_INDEX_VERSION,
    source,
    title: content.title,
    at,
    chunks: chunks.length,
    pages: content.basis === "full_text" ? content.pages.length : 0,
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
  includeReferences: z.boolean().default(false),
  match: z.enum(["all", "any", "phrase"]).default("all"),
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
  const queryTerms = [...new Set(searchTerms([args.query, ...expanded].join(" ")))];
  const originalTerms = new Set(searchTerms(args.query));
  const matchChunk = (c: PaperChunk) => {
    const tokens = new Set(words(c.text));
    const matchedTerms = queryTerms.filter(term => tokens.has(term));
    const matchedOriginal = [...originalTerms].filter(term => tokens.has(term));
    const phrase = words(args.query).join(" ");
    const exactPhrase = phrase.length > 0 && (` ${words(c.text).join(" ")} `).includes(` ${phrase} `);
    const allOriginal = originalTerms.size > 0 && matchedOriginal.length === originalTerms.size;
    const expandedMatch = expanded.some(term => { const terms = searchTerms(term); return terms.length > 0 && terms.every(t => tokens.has(t)); });
    const matches = matchedTerms.length > 0 && (args.match === "phrase" ? exactPhrase : args.match === "any" || allOriginal || (args.semantic && expandedMatch));
    return { matchedTerms, matchedOriginal, exactPhrase, matches };
  };
  const papers = status.sources
    .filter(
      (s) =>
        ["indexed", "abstract", "summary"].includes(s.status) &&
        (!args.keys || args.keys.includes(s.key)),
    )
    .map((s) => ({
      key: s.key,
      data: JSON.parse(readFileSync(file(id, s.key), "utf8")) as IndexedPaper,
    }));
  for (const paper of papers) Object.setPrototypeOf(paper.data.terms, null);
  const eligible = (c: PaperChunk) => args.includeReferences || c.section !== "references";
  const count = papers.reduce((n, p) => n + p.data.chunks.filter(eligible).length, 0);
  const average =
    papers.reduce(
      (n, p) => n + p.data.chunks.filter(eligible).reduce((m, c) => m + c.length, 0),
      0,
    ) / Math.max(1, count);
  const df = new Map(
    queryTerms.map((term) => [
      term,
      papers.reduce((n, p) => n + (p.data.terms[term]?.filter(([i]) => eligible(p.data.chunks[i])).length ?? 0), 0),
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
    section: PaperChunk["section"];
    matchedTerms: string[];
    source: SourceVersion;
  }[] = [];
  let excludedReferences = 0;
  for (const { key, data } of papers) {
    const scores = new Map<number, number>();
    for (const term of queryTerms)
      for (const [index, frequency] of data.terms[term] ?? []) {
        if (!eligible(data.chunks[index])) continue;
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
    for (const c of data.chunks) {
      if (c.section === "references" && matchChunk(c).matches) excludedReferences++;
    }
    for (const [index, score] of scores) {
      const c = data.chunks[index];
      const { matchedTerms, matchedOriginal, exactPhrase, matches } = matchChunk(c);
      if (!matches) continue;
      const window = passageWindow(c.text, matchedTerms);
      results.push({
        key,
        title: data.title,
        page: c.page,
        offset: c.start + window.start,
        quote: window.text,
        score: score * (1 + matchedOriginal.length / Math.max(1, originalTerms.size))
          * (exactPhrase ? 1.8 : 1) * (c.section === "references" ? 0.15 : 1),
        basis: data.source.basis,
        section: c.section,
        matchedTerms,
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
  const seen = new Map<string, [number, number][]>();
  const distinct = results.filter((r) => {
    const key = `${r.key}:${r.page}:${r.section}`;
    const offsets = seen.get(key) ?? [];
    const end = r.offset + r.quote.length;
    if (offsets.some(([start, stop]) => Math.min(end, stop) - Math.max(r.offset, start) > Math.min(r.quote.length, stop - start) / 2))
      return false;
    offsets.push([r.offset, end]);
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
    sourceCount: new Set(distinct.map(r => r.key)).size,
    excludedReferences: args.includeReferences ? 0 : excludedReferences,
    note: "Passages are verbatim extracts. Detected bibliography sections are excluded by default; section detection can miss unusual layouts. Matches indicate relevance, not support for a claim.",
  };
}
