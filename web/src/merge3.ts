/**
 * Line-based three-way merge for the Source editor: `base` is the content a
 * draft was typed over, `ours` the draft, `theirs` what is on disk now (an
 * agent turn, a sync, a rejected hunk). Regions changed on one side only take
 * that side; regions both sides changed identically take it once; regions
 * both changed differently become git-style conflict blocks
 * (<<<<<<< yours / ======= / >>>>>>> disk) so nothing is silently dropped.
 *
 * Pure and DOM-free (tested under node). Diffs come from Myers' O(ND)
 * algorithm on lines after common prefix/suffix trimming, which keeps the
 * usual case — a few edited lines in a long file — tiny.
 */

export interface MergeResult {
  text: string;
  /** Number of conflict blocks written into `text`. */
  conflicts: number;
}

/** One replacement: base lines [start, end) become `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Split keeping line identity; the trailing newline is remembered separately. */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

/**
 * Myers diff of two line arrays → hunks in `a` coordinates. Common prefix and
 * suffix are trimmed first. Falls back to one whole-middle replacement when
 * the edit distance would exceed MAX_D (pathological inputs stay bounded).
 */
export function diffHunks(a: string[], b: string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (A.length === 0 && B.length === 0) return [];
  if (A.length === 0 || B.length === 0) return [{ start: pre, end: pre + A.length, lines: B }];

  const N = A.length;
  const M = B.length;
  const MAX_D = Math.min(N + M, 20_000);
  const offset = MAX_D;
  const size = 2 * MAX_D + 1;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= MAX_D; d++) {
    trace.push(v);
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= N && y >= M) {
        v = next;
        found = true;
        break outer;
      }
    }
    v = next;
  }
  if (!found) return [{ start: pre, end: pre + N, lines: B }];

  // Walk the trace back to recover the edit script as (x, y) steps.
  type Op = { type: "eq" | "del" | "ins"; x: number; y: number };
  const ops: Op[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "eq", x: x - 1, y: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "ins", x, y: y - 1 });
      else ops.push({ type: "del", x: x - 1, y });
      x = prevX;
      y = prevY;
    }
  }
  ops.reverse();

  // Group consecutive non-equal ops into hunks.
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let ax = 0;
  for (const op of ops) {
    if (op.type === "eq") {
      cur = null;
      ax = op.x + 1;
      continue;
    }
    if (!cur) {
      cur = { start: pre + ax, end: pre + ax, lines: [] };
      hunks.push(cur);
    }
    if (op.type === "del") {
      cur.end = pre + op.x + 1;
      ax = op.x + 1;
    } else {
      cur.lines.push(B[op.y]);
    }
  }
  return hunks;
}

const OURS = "<<<<<<< yours";
const SEP = "=======";
const THEIRS = ">>>>>>> disk";

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: ours, conflicts: 0 };

  const b = splitLines(base);
  const o = splitLines(ours);
  const t = splitLines(theirs);
  const oh = diffHunks(b.lines, o.lines);
  const th = diffHunks(b.lines, t.lines);

  const out: string[] = [];
  let conflicts = 0;
  let pos = 0; // next base line not yet emitted
  let i = 0;
  let j = 0;
  while (i < oh.length || j < th.length) {
    // Pick the next region: the earliest hunk on either side, then absorb every
    // hunk on either side that overlaps (or touches, for insertions) it.
    const nextO = oh[i];
    const nextT = th[j];
    let start = Math.min(nextO?.start ?? Infinity, nextT?.start ?? Infinity);
    let end = start;
    const inO: Hunk[] = [];
    const inT: Hunk[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (i < oh.length && oh[i].start <= end && (oh[i].start < end || oh[i].end === oh[i].start || end === start)) {
        const h = oh[i++];
        inO.push(h);
        end = Math.max(end, h.end);
        grew = true;
      }
      while (j < th.length && th[j].start <= end && (th[j].start < end || th[j].end === th[j].start || end === start)) {
        const h = th[j++];
        inT.push(h);
        end = Math.max(end, h.end);
        grew = true;
      }
    }
    // Untouched base lines before the region.
    for (let k = pos; k < start; k++) out.push(b.lines[k]);
    const apply = (hs: Hunk[]): string[] => {
      const lines: string[] = [];
      let p = start;
      for (const h of hs) {
        for (let k = p; k < h.start; k++) lines.push(b.lines[k]);
        lines.push(...h.lines);
        p = h.end;
      }
      for (let k = p; k < end; k++) lines.push(b.lines[k]);
      return lines;
    };
    const oursLines = inO.length ? apply(inO) : b.lines.slice(start, end);
    const theirsLines = inT.length ? apply(inT) : b.lines.slice(start, end);
    if (inO.length === 0) out.push(...theirsLines);
    else if (inT.length === 0) out.push(...oursLines);
    else if (oursLines.join("\n") === theirsLines.join("\n")) out.push(...oursLines);
    else {
      conflicts++;
      out.push(OURS, ...oursLines, SEP, ...theirsLines, THEIRS);
    }
    pos = end;
  }
  for (let k = pos; k < b.lines.length; k++) out.push(b.lines[k]);

  const trailingNewline = ours === "" ? t.trailingNewline : o.trailingNewline || (t.trailingNewline && !o.lines.length);
  const text = out.join("\n") + (trailingNewline && out.length > 0 ? "\n" : "");
  return { text, conflicts };
}
