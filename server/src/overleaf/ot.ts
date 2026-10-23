/**
 * sharejs text-op computation for in-place Overleaf doc updates.
 * Overleaf's realtime channel applies ops of the form {p, i} (insert at
 * position) and {p, d} (delete at position) against the doc as one string.
 */

/** One sharejs text-op component: delete `d` or insert `i` at position `p`. */
export interface TextOpComponent {
  p: number;
  i?: string;
  d?: string;
}

/**
 * Minimal single-splice diff between two texts: trim the common prefix and
 * suffix, then emit at most a delete followed by an insert at the same
 * position (empty components omitted; [] when the texts are equal).
 * Byte-faithful: texts are compared exactly as given — a trailing-newline
 * difference is just part of the edit, never normalized away.
 */
export function computeTextOp(oldText: string, newText: string): TextOpComponent[] {
  if (oldText === newText) return [];
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = oldText.slice(prefix, oldText.length - suffix);
  const inserted = newText.slice(prefix, newText.length - suffix);
  const op: TextOpComponent[] = [];
  if (removed) op.push({ p: prefix, d: removed });
  if (inserted) op.push({ p: prefix, i: inserted });
  return op;
}

/** One replaced region of the OLD text: [start, end) becomes `insert`. */
export interface TextEdit {
  start: number;
  end: number;
  insert: string;
}

/** Lines with their "\n" kept, so joining them gives the text back exactly. */
function splitKeepingNewlines(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    out.push(text.slice(from, i + 1));
    from = i + 1;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** Above this many changed lines the diff falls back to one region. */
const MAX_DIFF_STEPS = 2000;

/**
 * Myers line diff of a → b: the changed regions as [aStart, aEnd, bStart,
 * bEnd], or null when more than MAX_DIFF_STEPS lines differ.
 */
function lineHunks(a: string[], b: string[]): [number, number, number, number][] | null {
  const n = a.length;
  const m = b.length;
  // trace[d][k + d] = furthest x on diagonal k after d edits.
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(n + m, MAX_DIFF_STEPS) && !found; d++) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const v = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) x = at(k + 1);
      else x = at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) found = true;
    }
    trace.push(v);
  }
  if (!found) return null;
  // Walk back from (n, m), collecting single-line deletes and inserts.
  const edits: { a: number; b: number; del: boolean }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    edits.push({ a: prevX, b: prevY, del: !down });
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  // Touching edits form one region.
  const hunks: [number, number, number, number][] = [];
  for (const e of edits) {
    const last = hunks[hunks.length - 1];
    if (last && last[1] === e.a && last[3] === e.b) {
      if (e.del) last[1]++;
      else last[3]++;
    } else {
      hunks.push(e.del ? [e.a, e.a + 1, e.b, e.b] : [e.a, e.a, e.b, e.b + 1]);
    }
  }
  return hunks;
}

/**
 * Where oldText and newText differ: a line diff with each changed region
 * trimmed to its differing characters. Text between regions is untouched, so
 * review comments and tracked changes anchored there survive. Sorted and
 * non-overlapping; [] when the texts are equal.
 */
export function computeTextEdits(oldText: string, newText: string): TextEdit[] {
  if (oldText === newText) return [];
  const a = splitKeepingNewlines(oldText);
  const b = splitKeepingNewlines(newText);
  const hunks = lineHunks(a, b) ?? [[0, a.length, 0, b.length]];
  const lineStart: number[] = [0];
  for (const line of a) lineStart.push(lineStart[lineStart.length - 1] + line.length);
  const edits: TextEdit[] = [];
  for (const [aStart, aEnd, bStart, bEnd] of hunks) {
    const from = lineStart[aStart];
    const removed = a.slice(aStart, aEnd).join("");
    const inserted = b.slice(bStart, bEnd).join("");
    // computeTextOp yields at most a delete then an insert, at the same position.
    const op = computeTextOp(removed, inserted);
    if (op.length === 0) continue;
    const p = from + op[0].p;
    const deleted = op.find((c) => c.d !== undefined)?.d ?? "";
    edits.push({ start: p, end: p + deleted.length, insert: op.find((c) => c.i !== undefined)?.i ?? "" });
  }
  return edits;
}

/**
 * Like computeTextOp, but one delete/insert pair per changed region instead of
 * one splice from the first change to the last (see computeTextEdits). Each
 * component applies to the text the previous ones produced (sharejs rules).
 */
export function computeTextOpHunks(oldText: string, newText: string): TextOpComponent[] {
  const op: TextOpComponent[] = [];
  let shift = 0;
  for (const e of computeTextEdits(oldText, newText)) {
    const p = e.start + shift;
    if (e.end > e.start) op.push({ p, d: oldText.slice(e.start, e.end) });
    if (e.insert) op.push({ p, i: e.insert });
    shift += e.insert.length - (e.end - e.start);
  }
  return op;
}

/** A span of a history-OT doc's stored content. */
export interface ContentSpan {
  pos: number;
  length: number;
}

/** Sorted, merged spans, clamped to [0, max]. */
export function normalizeSpans(spans: ContentSpan[], max: number): ContentSpan[] {
  const sorted = spans
    .map((s) => ({ pos: Math.max(0, Math.min(max, s.pos)), end: Math.max(0, Math.min(max, s.pos + s.length)) }))
    .filter((s) => s.end > s.pos)
    .sort((x, y) => x.pos - y.pos);
  const out: ContentSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.pos <= last.pos + last.length) last.length = Math.max(last.length, s.end - last.pos);
    else out.push({ pos: s.pos, length: s.end - s.pos });
  }
  return out;
}

/** The content without the given (normalized) spans. */
export function withoutSpans(content: string, spans: ContentSpan[]): string {
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += content.slice(cursor, s.pos);
    cursor = s.pos + s.length;
  }
  return out + content.slice(cursor);
}

/**
 * A history-OT text operation (positive number = retain, string = insert,
 * negative number = delete) that turns a doc's visible text into `target`.
 * `content` is the stored text, which also holds tracked-deleted spans
 * (`hidden`) the visible text leaves out; those are retained, never deleted.
 * The operation spans the whole content, as the server requires.
 */
export function historyTextOperation(content: string, hidden: ContentSpan[], target: string): (number | string)[] {
  const spans = normalizeSpans(hidden, content.length);
  const ops: (number | string)[] = [];
  const push = (op: number | string) => {
    const last = ops[ops.length - 1];
    if (typeof op === "string") {
      if (typeof last === "string") ops[ops.length - 1] = last + op;
      else ops.push(op);
    } else if (typeof last === "number" && Math.sign(last) === Math.sign(op)) ops[ops.length - 1] = last + op;
    else ops.push(op);
  };
  let ci = 0;
  let vi = 0;
  let si = 0;
  /** Move to visible offset `to`, retaining or deleting visible text; hidden spans are retained. */
  const advance = (to: number, del: boolean) => {
    while (vi < to) {
      if (si < spans.length && spans[si].pos === ci) {
        push(spans[si].length);
        ci += spans[si].length;
        si++;
        continue;
      }
      const nextHidden = si < spans.length ? spans[si].pos : Number.POSITIVE_INFINITY;
      const step = Math.min(to - vi, nextHidden - ci);
      push(del ? -step : step);
      ci += step;
      vi += step;
    }
  };
  for (const e of computeTextEdits(withoutSpans(content, spans), target)) {
    advance(e.start, false);
    if (e.insert) push(e.insert);
    advance(e.end, true);
  }
  if (content.length > ci) push(content.length - ci);
  return ops;
}
