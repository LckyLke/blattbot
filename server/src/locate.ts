/**
 * Locate text copied from a rendered PDF in the project's .tex sources.
 *
 * Both sides are folded into comparable word streams: ligatures expand
 * (ﬁ→fi, ﬂ→fl, …), soft hyphens vanish, and words split by line-break
 * hyphenation are rejoined ("exam- ple" → "example"). On the source side
 * LaTeX syntax (comments, \commands, braces, math delimiters) is stripped
 * so prose matches what the PDF shows, while every surviving word keeps the
 * 1-indexed line it started on. Matching finds the longest run of
 * consecutive shared words; a hit needs ≥4 consecutive words or ≥60% of
 * the query, and reports the source line where the matched run begins.
 */

export interface SourceFile {
  file: string;
  content: string;
}

export interface LocateHit {
  file: string;
  /** 1-indexed line of the first word of the best matching run. */
  line: number;
  /** Number of consecutive words matched. */
  matched: number;
}

interface Token {
  /** Comparison key: folded, lowercased alphanumerics only. */
  key: string;
  /** 1-indexed line the word starts on. */
  line: number;
  /** The raw word ended in "-" — a line-break hyphenation candidate. */
  hyphen: boolean;
}

/** Expand typographic ligatures and drop soft hyphens. */
function foldGlyphs(s: string): string {
  return s
    .replace(/\u00AD/g, "")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl");
}

/** A word's comparison key — lowercase letters and digits only. */
function wordKey(w: string): string {
  return foldGlyphs(w).toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, "");
}

/** Cut an unescaped % comment off a line. */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++; // the next char is escaped — skip it
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

/**
 * Tokenize text (a .tex file or a PDF snippet — the pipeline is shared) into
 * comparison words carrying their original line numbers. LaTeX control words
 * disappear but the text inside their brace arguments survives, so
 * `\section{Introduction}` still contributes "introduction" on that line.
 */
export function tokenize(text: string): Token[] {
  const raw: Token[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cleaned = stripComment(lines[i])
      .replace(/\\\\/g, " ") // hard line breaks
      .replace(/\\([%&$#_{}])/g, "$1") // escaped specials keep their character
      .replace(/\\[a-zA-Z@]+\*?/g, " ") // control words vanish; brace args' text stays
      .replace(/[{}$~^_&]/g, " "); // structure characters separate words
    for (const piece of cleaned.split(/\s+/)) {
      if (!piece) continue;
      const key = wordKey(piece);
      raw.push({
        key,
        line: i + 1,
        hyphen: /[a-zA-Z0-9À-ɏ]-$/.test(foldGlyphs(piece)),
      });
    }
  }
  // Drop punctuation-only tokens, then rejoin words split by hyphenation:
  // "exam-" + "ple" → "example", kept on the first fragment's line.
  const words = raw.filter((t) => t.key.length > 0);
  const out: Token[] = [];
  for (const t of words) {
    const prev = out[out.length - 1];
    if (prev?.hyphen && /^[a-zÀ-ɏ]/.test(t.key)) {
      prev.key += t.key;
      prev.hyphen = t.hyphen;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/** Longest run of consecutive shared words between query and source. */
function bestRun(q: string[], src: Token[]): { len: number; start: number } {
  let prev = new Int32Array(q.length);
  let cur = new Int32Array(q.length);
  let len = 0;
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    const key = src[i].key;
    for (let j = 0; j < q.length; j++) {
      cur[j] = key === q[j] ? (j > 0 ? prev[j - 1] : 0) + 1 : 0;
      if (cur[j] > len) {
        len = cur[j];
        start = i - cur[j] + 1;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { len, start };
}

/**
 * Find the best position of `query` (text lifted from the PDF) across the
 * given source files. Scored by matched word count; a hit needs at least
 * 4 consecutive words, or 60% of the query when the query is shorter.
 */
export function locateInSources(query: string, files: SourceFile[]): LocateHit | null {
  const q = tokenize(query).map((t) => t.key);
  if (q.length === 0) return null;
  const need = Math.min(4, Math.max(1, Math.ceil(q.length * 0.6)));
  let best: LocateHit | null = null;
  for (const { file, content } of files) {
    const src = tokenize(content);
    if (src.length === 0) continue;
    const { len, start } = bestRun(q, src);
    if (len >= need && (best === null || len > best.matched)) {
      best = { file, line: src[start].line, matched: len };
    }
  }
  return best;
}
