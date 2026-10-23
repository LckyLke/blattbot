// Turn checkpoints (show / undo one agent turn), restoring a discard, and the
// queue of messages waiting for the running turn.
import type { FastifyInstance } from "fastify";
import { getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";
import { appendEvent, getChat } from "../chats.js";
import {
  changedFiles,
  diffBetween,
  parseTurnRef,
  restoreDiscard,
  turnShas,
  undoTurn,
  withDiscardCheckpoint,
  type ReverseResult,
} from "../checkpoints.js";
import { queueState, removeQueued, resumeQueue } from "../turn-queue.js";
import { startNextQueued } from "../turn-runner.js";

const BUSY = "The agent is still working — wait for the turn to end (or stop it), then try again.";

/** One line for the chat about what an undo or restore did. */
export function describeReverse(what: string, r: ReverseResult): { tone: "ok" | "warn"; text: string } {
  const n = r.restored.length + r.merged.length + r.conflicts.length;
  const parts = [`${what}: ${n} file${n === 1 ? "" : "s"} put back`];
  if (r.merged.length) parts.push(`later edits kept in ${r.merged.join(", ")}`);
  if (r.conflicts.length) parts.push(`conflict markers in ${r.conflicts.join(", ")} — resolve them in Source`);
  if (r.skipped.length) parts.push(`left alone: ${r.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
  return { tone: r.conflicts.length || r.skipped.length ? "warn" : "ok", text: `${parts.join("; ")}.` };
}

export function registerTurnRoutes(app: FastifyInstance): void {
  // What one turn changed: its before → after snapshots, read-only.
  app.get<{ Params: { id: string; turnRef: string } }>("/api/projects/:id/turns/:turnRef/diff", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (!parseTurnRef(req.params.turnRef)) return reply.code(400).send({ error: "invalid turn" });
    const dir = projectDir(project.id);
    const shas = await turnShas(dir, req.params.turnRef);
    if (!shas) return reply.code(404).send({ error: "This turn's checkpoint is no longer kept (only the last 50 turns are)." });
    const [diff, files] = await Promise.all([diffBetween(dir, shas.before, shas.after), changedFiles(dir, shas.before, shas.after)]);
    return { turnRef: req.params.turnRef, beforeSha: shas.before, afterSha: shas.after, diff, files };
  });

  // Undo one turn in the current worktree: a three-way merge per file, so
  // edits made after the turn stay. The undo itself gets a restore point.
  app.post<{ Params: { id: string; turnRef: string } }>("/api/projects/:id/turns/:turnRef/undo", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const parsed = parseTurnRef(req.params.turnRef);
    if (!parsed) return reply.code(400).send({ error: "invalid turn" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: BUSY });
    const dir = projectDir(project.id);
    let outcome: { result: ReverseResult | null; discardId?: string; diff: string };
    try {
      outcome = await withProjectLock(project.id, async () => {
        const saved = await withDiscardCheckpoint(dir, () => undoTurn(dir, req.params.turnRef));
        return { result: saved.result, discardId: saved.discardId, diff: await git.workingDiff(dir) };
      });
    } catch (err: any) {
      return reply.code(422).send({ error: `Undo failed: ${err?.message ?? err}` });
    }
    if (!outcome.result) {
      return reply.code(404).send({ error: "This turn's checkpoint is no longer kept (only the last 50 turns are)." });
    }
    const line = describeReverse("Turn undone", outcome.result);
    const event = { type: "turn_undone", turnRef: req.params.turnRef, ...outcome.result, tone: line.tone, text: line.text };
    if (getChat(project.id, parsed.chatId)) {
      try {
        appendEvent(project.id, parsed.chatId, event);
      } catch {
        /* the broadcast below still reports it */
      }
    }
    broadcast(project.id, { ...event, chatId: parsed.chatId });
    broadcast(project.id, { type: "diff", diff: outcome.diff });
    return { ok: true, ...outcome.result, ...(outcome.discardId ? { discardId: outcome.discardId } : {}), diff: outcome.diff };
  });

  // Put back what a discard (or an undo) threw away. `turnRef`: the restore
  // point is that turn's undo — its card in the chat is marked undone no more.
  app.post<{ Params: { id: string; discardId: string }; Body: { turnRef?: unknown } | undefined }>("/api/projects/:id/discards/:discardId/restore", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: BUSY });
    const turnRef = typeof req.body?.turnRef === "string" ? req.body.turnRef : undefined;
    const turn = turnRef ? parseTurnRef(turnRef) : null;
    if (turnRef && !turn) return reply.code(400).send({ error: "invalid turn" });
    const dir = projectDir(project.id);
    let outcome: { result: ReverseResult | null; diff: string };
    try {
      outcome = await withProjectLock(project.id, async () => {
        const result = await restoreDiscard(dir, req.params.discardId);
        return { result, diff: await git.workingDiff(dir) };
      });
    } catch (err: any) {
      return reply.code(422).send({ error: `Restore failed: ${err?.message ?? err}` });
    }
    if (!outcome.result) return reply.code(404).send({ error: "That restore point is no longer kept." });
    const line = describeReverse(turn ? "Turn restored" : "Restored", outcome.result);
    if (turn && turnRef) {
      const event = { type: "turn_redone", turnRef, tone: line.tone, text: line.text };
      if (getChat(project.id, turn.chatId)) {
        try {
          appendEvent(project.id, turn.chatId, event);
        } catch {
          /* the broadcast below still reports it */
        }
      }
      broadcast(project.id, { ...event, chatId: turn.chatId });
    }
    broadcast(project.id, { type: "diff", diff: outcome.diff });
    return { ok: true, ...outcome.result, ...line, diff: outcome.diff, ...(turn ? { reported: true } : {}) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/queue", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return queueState(project.id);
  });

  app.delete<{ Params: { id: string; itemId: string } }>("/api/projects/:id/queue/:itemId", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (!removeQueued(project.id, req.params.itemId)) {
      return reply.code(404).send({ error: "That message is no longer queued — it may have started already." });
    }
    return queueState(project.id);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/queue/resume", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    resumeQueue(project.id);
    const started = startNextQueued(project.id);
    return { ...queueState(project.id), started };
  });
}
