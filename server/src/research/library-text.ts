/** Keep exact page offsets while separating a paper's prose from its bibliography. */
export const LIBRARY_INDEX_VERSION = 2;
export type PaperSection = "body" | "references" | "appendix";
export interface PaperChunk {
  page: number;
  start: number;
  text: string;
  length: number;
  section: PaperSection;
}
export const words = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\p{L})-\s+(?=\p{Ll})/gu, "$1")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const stopWords = new Set(
  "a an the of for to in on at by with from and or as is are was were be been being it its this that these those we our their they you your how what which where when why can could would should does do did using used use show shows paper study about into than then also has have had".split(
    " ",
  ),
);
export const searchTerms = (text: string) =>
  words(text).filter((word) => !stopWords.has(word));

export function paperChunks(pages: string[]): PaperChunk[] {
  const chunks: PaperChunk[] = [];
  let section: PaperSection = "body";
  pages.forEach((page, p) => {
    // Standalone headings only: a sentence mentioning references is still prose.
    const headings = [
      ...page.matchAll(
        /^[ \t]*(?:(?:\d+(?:\.\d+)*\.?|[IVX]+)[ \t]+)?(?:references|bibliography|works cited|literature cited|appendi(?:x|ces)(?:[ \t]+[A-Z0-9]+)?(?:[ \t]*[.:—–-][^\n]*)?|supplementary (?:material|information))[: \t]*$/gim,
      ),
    ];
    let start = 0;
    const append = (end: number) => {
      for (let at = start; at < end; ) {
        let stop = Math.min(end, at + 1100);
        if (stop < end) {
          const boundary = page.lastIndexOf(" ", stop);
          if (boundary > at + 550) stop = boundary;
        }
        const text = page.slice(at, stop);
        if (text.trim())
          chunks.push({
            page: p + 1,
            start: at,
            text,
            length: words(text).length,
            section,
          });
        if (stop === end) break;
        at = Math.max(at + 1, stop - 160);
      }
    };
    for (const heading of headings) {
      append(heading.index!);
      section = /appendi|supplementary/i.test(heading[0])
        ? "appendix"
        : "references";
      start = heading.index!;
    }
    append(page.length);
  });
  return chunks;
}

/** A compact verbatim window near the densest query match, never generated text. */
export function passageWindow(text: string, terms: string[], size = 650) {
  if (text.length <= size) return { text, start: 0 };
  const hits = [...text.matchAll(/[\p{L}\p{N}]+/gu)]
    .filter((m) => terms.includes(m[0].normalize("NFKC").toLowerCase()))
    .map((m) => m.index!);
  let best = 0,
    bestScore = -1;
  for (const hit of hits) {
    const start = Math.max(0, Math.min(hit - 120, text.length - size));
    const score = hits.filter((at) => at >= start && at < start + size).length;
    if (score > bestScore) {
      best = start;
      bestScore = score;
    }
  }
  if (best > 0) {
    const space = text.indexOf(" ", best);
    if (space < best + 40 && space >= 0) best = space + 1;
  }
  let end = Math.min(text.length, best + size);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > end - 40) end = space;
  }
  return { text: text.slice(best, end), start: best };
}
