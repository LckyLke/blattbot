/**
 * Messages sent while an agent turn runs wait here, per project, in arrival
 * order (in memory: a restart drops them). The turn runner starts the next
 * one when a turn ends cleanly; a turn that failed or was stopped pauses the
 * queue until the user resumes it. Every change is broadcast as a `queue`
 * event so all open tabs show the same list.
 */
import { randomBytes } from "node:crypto";
import { broadcast } from "./events.js";
import type { TurnRequest } from "./turn-runner.js";

/** Messages a project may have waiting at once. */
export const MAX_QUEUED = 5;

export interface QueuedTurn {
  id: string;
  chatId: string;
  request: TurnRequest;
  queuedAt: string;
}

interface ProjectQueue {
  items: QueuedTurn[];
  /** Why the queue is not starting its next message ("error" | "interrupted"). */
  paused?: "error" | "interrupted";
}

/** What the UI shows of a queue. */
export interface PublicQueue {
  items: { id: string; chatId: string; text: string; mode: string; images: number; queuedAt: string }[];
  paused: "error" | "interrupted" | null;
}

const queues = new Map<string, ProjectQueue>();

export class QueueFullError extends Error {}

export function queueState(projectId: string): PublicQueue {
  const q = queues.get(projectId);
  return {
    items: (q?.items ?? []).map((item) => ({
      id: item.id,
      chatId: item.chatId,
      text: item.request.message,
      mode: item.request.mode,
      images: item.request.attachments.length,
      queuedAt: item.queuedAt,
    })),
    paused: q?.items.length ? (q.paused ?? null) : null,
  };
}

function changed(projectId: string): void {
  const q = queues.get(projectId);
  if (q && q.items.length === 0) queues.delete(projectId);
  broadcast(projectId, { type: "queue", ...queueState(projectId) });
}

export function enqueueTurn(projectId: string, chatId: string, request: TurnRequest): QueuedTurn {
  const q = queues.get(projectId) ?? { items: [] };
  if (q.items.length >= MAX_QUEUED) {
    throw new QueueFullError(`At most ${MAX_QUEUED} messages can wait for the agent — remove one or wait for the turn to end.`);
  }
  const item: QueuedTurn = { id: `q-${randomBytes(4).toString("hex")}`, chatId, request, queuedAt: new Date().toISOString() };
  q.items.push(item);
  queues.set(projectId, q);
  changed(projectId);
  return item;
}

export function removeQueued(projectId: string, id: string): boolean {
  const q = queues.get(projectId);
  const before = q?.items.length ?? 0;
  if (!q) return false;
  q.items = q.items.filter((item) => item.id !== id);
  if (q.items.length === before) return false;
  changed(projectId);
  return true;
}

/** The next message to run, unless the queue is paused or empty. */
export function takeNextQueued(projectId: string): QueuedTurn | undefined {
  const q = queues.get(projectId);
  if (!q || q.paused || q.items.length === 0) return undefined;
  const next = q.items.shift();
  changed(projectId);
  return next;
}

/** Stop starting queued messages (the last turn failed or was stopped). */
export function pauseQueue(projectId: string, reason: "error" | "interrupted"): void {
  const q = queues.get(projectId);
  if (!q || q.items.length === 0) return;
  q.paused = reason;
  changed(projectId);
}

export function resumeQueue(projectId: string): void {
  const q = queues.get(projectId);
  if (!q) return;
  delete q.paused;
  changed(projectId);
}

export function clearQueue(projectId: string): void {
  if (!queues.has(projectId)) return;
  queues.delete(projectId);
  broadcast(projectId, { type: "queue", ...queueState(projectId) });
}

/** Drop the messages written in one chat (the chat was deleted). */
export function dropChatFromQueue(projectId: string, chatId: string): void {
  const q = queues.get(projectId);
  if (!q) return;
  const before = q.items.length;
  q.items = q.items.filter((item) => item.chatId !== chatId);
  if (q.items.length !== before) changed(projectId);
}

/** Image ids queued messages still need — the chat-uploads sweep must keep them. */
export function queuedImageIds(projectId: string): string[] {
  return (queues.get(projectId)?.items ?? []).flatMap((item) => item.request.attachments.map((a) => a.id));
}
