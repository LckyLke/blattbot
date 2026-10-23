/**
 * Review state for the mock Overleaf (mock-overleaf.ts): comment ranges and
 * tracked changes of sharejs docs, comment threads, and history-OT docs.
 * Shapes follow overleaf/overleaf (real-time WebsocketController.joinDoc,
 * document-updater RangesManager, web threads API); the range bookkeeping is
 * a simplified version of Overleaf's ranges tracker.
 */
import { randomBytes } from "node:crypto";

export interface MockUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
}

/** The signed-in mock user (the BlattBot user). */
export const MOCK_USER: MockUser = {
  id: "5f00000000000000000000aa",
  first_name: "Mock",
  last_name: "User",
  email: "mock@example.org",
};

export interface MockComment {
  id: string;
  op: { c: string; p: number; t: string };
}

export interface MockChange {
  id: string;
  op: { p: number; i?: string; d?: string };
  metadata: { user_id: string; ts: string };
}

export interface MockRanges {
  comments: MockComment[];
  changes: MockChange[];
}

export interface MockThreadMessage {
  id: string;
  content: string;
  timestamp: number;
  user_id: string;
  user: MockUser;
}

export interface MockThread {
  messages: MockThreadMessage[];
  resolved?: boolean;
  resolved_at?: string;
  resolved_by_user_id?: string;
  resolved_by_user?: MockUser;
}

export interface HistorySpan {
  pos: number;
  length: number;
}

/** A history-OT doc as document-updater stores it (StringFileData raw). */
export interface HistoryDoc {
  /** Includes tracked-deleted text. */
  content: string;
  comments: { id: string; ranges: HistorySpan[]; resolved?: boolean }[];
  trackedChanges: { range: HistorySpan; tracking: { type: "insert" | "delete"; userId: string; ts: string } }[];
}

/** A 24-hex ObjectId-like id. */
export function newObjectId(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + randomBytes(8).toString("hex");
}

export function emptyRanges(): MockRanges {
  return { comments: [], changes: [] };
}

/** Ranges as joinDoc sends them; with encodeRanges the texts are escaped like the lines. */
export function rangesForJoin(ranges: MockRanges | undefined, encode: ((s: string) => string) | null): MockRanges {
  const e = (s: string) => (encode ? encode(s) : s);
  return {
    comments: (ranges?.comments ?? []).map((c) => ({ id: c.id, op: { ...c.op, c: e(c.op.c) } })),
    changes: (ranges?.changes ?? []).map((c) => ({
      id: c.id,
      op: { p: c.op.p, ...(c.op.i !== undefined ? { i: e(c.op.i) } : {}), ...(c.op.d !== undefined ? { d: e(c.op.d) } : {}) },
      metadata: { ...c.metadata },
    })),
  };
}

export interface TrackContext {
  /** meta.tc of the update. */
  seed: string;
  counter: { n: number };
  userId: string;
}

function nextId(track: TrackContext): string {
  track.counter.n++;
  return track.seed + track.counter.n.toString(16).padStart(6, "0");
}

/** Shift ranges for an insert of `len` chars at `p`. A range starting at p moves; one strictly containing p grows. */
function insertIntoSpan(start: number, length: number, p: number, len: number): { start: number; length: number } {
  if (p <= start) return { start: start + len, length };
  if (p < start + length) return { start, length: length + len };
  return { start, length };
}

/** Shrink/move a range for a delete of [p, p + len). */
function deleteFromSpan(start: number, length: number, p: number, len: number): { start: number; length: number } {
  const end = start + length;
  const delEnd = p + len;
  const overlap = Math.max(0, Math.min(end, delEnd) - Math.max(start, p));
  const newStart = start >= delEnd ? start - len : start > p ? p : start;
  return { start: newStart, length: length - overlap };
}

/**
 * Apply one sharejs component to the doc text and its ranges. With `track`,
 * the insert/delete is recorded as a tracked change (the deleted text leaves
 * the doc, as in Overleaf). Returns the new text, or an error message.
 */
export function applyShareJsComponent(
  text: string,
  ranges: MockRanges,
  comp: any,
  track: TrackContext | null,
): { text: string } | { error: string } {
  if (typeof comp?.p !== "number" || comp.p < 0 || comp.p > text.length) return { error: "invalid op position" };
  const p: number = comp.p;
  if (typeof comp.i === "string") {
    const len = comp.i.length;
    for (const c of ranges.comments) {
      const before = c.op.c;
      const next = insertIntoSpan(c.op.p, before.length, p, len);
      if (next.length !== before.length) c.op.c = before.slice(0, p - c.op.p) + comp.i + before.slice(p - c.op.p);
      c.op.p = next.start;
    }
    for (const ch of ranges.changes) {
      if (ch.op.i !== undefined) {
        const next = insertIntoSpan(ch.op.p, ch.op.i.length, p, len);
        if (next.length !== ch.op.i.length) ch.op.i = ch.op.i.slice(0, p - ch.op.p) + comp.i + ch.op.i.slice(p - ch.op.p);
        ch.op.p = next.start;
      } else if (p <= ch.op.p) ch.op.p += len;
    }
    if (track) ranges.changes.push({ id: nextId(track), op: { p, i: comp.i }, metadata: { user_id: track.userId, ts: new Date().toISOString() } });
    return { text: text.slice(0, p) + comp.i + text.slice(p) };
  }
  if (typeof comp.d === "string") {
    if (text.slice(p, p + comp.d.length) !== comp.d) return { error: "Delete component does not match" };
    const len = comp.d.length;
    for (const c of ranges.comments) {
      const cs = c.op.p;
      const next = deleteFromSpan(cs, c.op.c.length, p, len);
      const from = Math.max(0, Math.min(c.op.c.length, p - cs));
      const to = Math.max(0, Math.min(c.op.c.length, p + len - cs));
      c.op.c = c.op.c.slice(0, from) + c.op.c.slice(to);
      c.op.p = next.start;
    }
    ranges.changes = ranges.changes.filter((ch) => {
      if (ch.op.i !== undefined) {
        const next = deleteFromSpan(ch.op.p, ch.op.i.length, p, len);
        const from = Math.max(0, Math.min(ch.op.i.length, p - ch.op.p));
        const to = Math.max(0, Math.min(ch.op.i.length, p + len - ch.op.p));
        ch.op.i = ch.op.i.slice(0, from) + ch.op.i.slice(to);
        ch.op.p = next.start;
        return next.length > 0;
      }
      if (ch.op.p >= p + len) ch.op.p -= len;
      else if (ch.op.p > p) ch.op.p = p;
      return true;
    });
    if (track) ranges.changes.push({ id: nextId(track), op: { p, d: comp.d }, metadata: { user_id: track.userId, ts: new Date().toISOString() } });
    return { text: text.slice(0, p) + text.slice(p + len) };
  }
  if (typeof comp.c === "string") {
    if (text.slice(p, p + comp.c.length) !== comp.c) return { error: "Comment component does not match" };
    ranges.comments.push({ id: String(comp.t), op: { c: comp.c, p, t: String(comp.t) } });
    return { text };
  }
  return { error: "unknown op component" };
}

/** The visible text: content without the tracked-deleted spans. */
export function historyVisible(doc: HistoryDoc): string {
  const hidden = doc.trackedChanges.filter((t) => t.tracking.type === "delete").map((t) => t.range).sort((a, b) => a.pos - b.pos);
  let out = "";
  let cursor = 0;
  for (const h of hidden) {
    if (h.pos < cursor) continue;
    out += doc.content.slice(cursor, h.pos);
    cursor = h.pos + h.length;
  }
  return out + doc.content.slice(cursor);
}

/** Content offset of visible character `visiblePos` (hidden spans before it are skipped). */
export function historyContentPos(doc: HistoryDoc, visiblePos: number): number {
  const hidden = doc.trackedChanges.filter((t) => t.tracking.type === "delete").map((t) => t.range).sort((a, b) => a.pos - b.pos);
  let pos = visiblePos;
  for (const h of hidden) {
    if (h.pos > pos) break;
    pos += h.length;
  }
  return pos;
}

/**
 * Apply a history-OT text operation (retain n > 0, insert "s", delete -n) to
 * the doc, keeping comment and tracked-change spans in place. The operation
 * must span the whole content. Returns an error message, or null.
 */
export function applyTextOperation(doc: HistoryDoc, ops: unknown): string | null {
  if (!Array.isArray(ops)) return "textOperation must be an array";
  let base = 0;
  for (const op of ops) {
    if (typeof op === "number" && Number.isInteger(op) && op !== 0) base += Math.abs(op);
    else if (typeof op === "string") continue;
    else if (op && typeof op === "object" && typeof (op as any).i === "string") continue;
    else if (op && typeof op === "object" && typeof (op as any).r === "number") base += (op as any).r;
    else return `unsupported text operation component ${JSON.stringify(op)}`;
  }
  if (base !== doc.content.length) return "The operation's base length must be equal to the string's length.";
  const spans = (): HistorySpan[] => [...doc.comments.flatMap((c) => c.ranges), ...doc.trackedChanges.map((t) => t.range)];
  let cursor = 0;
  for (const op of ops) {
    if (typeof op === "number" && op > 0) cursor += op;
    else if (typeof op === "object" && op && typeof (op as any).r === "number") cursor += (op as any).r;
    else if (typeof op === "string" || (op && typeof op === "object")) {
      const s = typeof op === "string" ? op : String((op as any).i);
      for (const span of spans()) {
        const next = insertIntoSpan(span.pos, span.length, cursor, s.length);
        span.pos = next.start;
        span.length = next.length;
      }
      doc.content = doc.content.slice(0, cursor) + s + doc.content.slice(cursor);
      cursor += s.length;
    } else if (typeof op === "number" && op < 0) {
      const len = -op;
      for (const span of spans()) {
        const next = deleteFromSpan(span.pos, span.length, cursor, len);
        span.pos = next.start;
        span.length = next.length;
      }
      doc.content = doc.content.slice(0, cursor) + doc.content.slice(cursor + len);
    }
  }
  doc.trackedChanges = doc.trackedChanges.filter((t) => t.range.length > 0);
  return null;
}
