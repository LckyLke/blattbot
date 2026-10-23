// The agent-turn pipeline behind POST /api/projects/:id/chat: pre-turn sync,
// the turn checkpoints, the backend turn with its live-diff event sink, the
// authoritative diff, transcript persistence and the broadcasts. The PDF
// refresh runs after the turn is over (the project is no longer busy), and the
// next queued message starts as soon as the turn ends cleanly.
import { promptWithFileMentions, type FileMention } from "./file-mentions.js";
import { getProject, projectDir, type Project } from "./config.js";
import * as git from "./git.js";
import { projectFingerprint } from "./project-fingerprint.js";
import { beginTurnPipeline, endTurnPipeline, isTurnActive, runTurn, type AgentMode } from "./agent.js";
import { broadcast } from "./events.js";
import { appendEvent, countUserMessages, getChat, updateChat } from "./chats.js";
import { makeTurnEventSink } from "./livediff.js";
import { withProjectLock } from "./project-lock.js";
import * as sync from "./sync.js";
import type { TurnAttachment } from "./chatimages.js";
import {
  beginTurnCheckpoint,
  endTurnCheckpoint,
  freeTurnNumber,
  pruneTurnRefs,
  type FileChange,
  type TurnCheckpoint,
} from "./checkpoints.js";
import { compileWorkingTree } from "./compile-service.js";
import { clearQueue, pauseQueue, takeNextQueued } from "./turn-queue.js";

/** A validated chat message, ready to run as an agent turn. */
export interface TurnRequest {
  /** The chat the message belongs to (validated by the caller). */
  chatId: string;
  /** Trimmed message text; empty when the message is images only. */
  message: string;
  mode: AgentMode;
  /** Files the turn is limited to; undefined = the whole project. */
  scope?: string[];
  mentions: FileMention[];
  attachments: TurnAttachment[];
}

/** The turn_end event lists at most this many files (the totals cover all). */
const MAX_TURN_FILES = 100;

/** What a turn_end carries about the turn's checkpoint. */
function checkpointFields(cp: TurnCheckpoint): Record<string, unknown> {
  const sum = (key: "additions" | "deletions") => cp.files.reduce((n, f) => n + f[key], 0);
  return {
    turnRef: cp.turnRef,
    beforeSha: cp.beforeSha,
    afterSha: cp.afterSha,
    files: cp.files.slice(0, MAX_TURN_FILES),
    fileCount: cp.files.length,
    additions: sum("additions"),
    deletions: sum("deletions"),
  };
}

/** Changed files the turn's scope did not allow (reachable only through a shell). */
function outsideScope(files: FileChange[], scope: string[] | undefined): string[] {
  if (!scope?.length) return [];
  const allowed = new Set(scope.map((s) => s.replace(/^\.\//, "")));
  return files.map((f) => f.path).filter((p) => !allowed.has(p));
}

/**
 * Start an agent turn on the request's chat and return once it runs.
 *
 * The user message is persisted and the project is marked busy
 * (isTurnActive) synchronously, before this returns — so a caller that has
 * just checked isTurnActive must not await between that check and this call.
 * Everything else runs in the background and reports over the websocket.
 */
export function startTurn(project: Project, request: TurnRequest, options: { fromQueue?: boolean } = {}): void {
  const { chatId, message, mode, scope, mentions, attachments } = request;
  const chat = getChat(project.id, chatId);
  if (!chat) throw new Error(`unknown chat: ${chatId}`);
  const userMessage = {
    type: "user_message",
    text: message,
    ...(mentions.length ? { mentions } : {}),
    mode,
    ...(scope ? { scope } : {}),
    // id + mime is all the restored transcript needs to render a thumbnail.
    ...(attachments.length > 0 ? { attachments: attachments.map((a) => ({ id: a.id, mime: a.mime })) } : {}),
  };
  try {
    appendEvent(project.id, chatId, userMessage);
  } catch {
    /* persistence must never block the turn */
  }
  /** Every live event names its chat, so a tab showing another chat ignores it. */
  const send = (event: Record<string, unknown>) => broadcast(project.id, { ...event, chatId });
  // The sending tab shows its own message; a queued one starts here, unseen.
  if (options.fromQueue) send({ ...userMessage, fromQueue: true });
  /** Durable subset of the stream — deltas are skipped; text_final has the full text. */
  const persist = (event: Record<string, unknown>) => {
    try {
      const t = event.type;
      if (
        t === "text_final" ||
        t === "tool_use" ||
        t === "tool_result" ||
        t === "turn_end" ||
        t === "notice" ||
        t === "question" ||
        t === "question_answered" ||
        t === "question_dismissed"
      ) {
        appendEvent(project.id, chatId, event as { type: string });
      } else if (t === "error") {
        appendEvent(project.id, chatId, {
          type: "notice",
          tone: "error",
          text: String(event.message ?? "agent error"),
        });
      }
    } catch {
      /* best effort */
    }
  };
  const notice = (tone: string, text: string) => {
    const event = { type: "notice", tone, text };
    send(event);
    persist(event);
  };

  // Run the turn in the background; progress streams over the websocket.
  // isTurnActive (the 409 guards, the polled turnActive field) stays true for
  // the whole pipeline up to the turn_end below — the diff and the checkpoint
  // touch the same working tree the next turn would.
  beginTurnPipeline(project.id);
  void (async () => {
    const dir = projectDir(project.id);
    /** The backend's own turn_end, held back until the checkpoint is known. */
    const turn: { ended: Record<string, unknown> | null } = { ended: null };
    let failed = false;
    let changed = false;
    let checkpoint: TurnCheckpoint | null = null;
    try {
      send({ type: "turn_start" });
      const beforeTurn = await projectFingerprint(dir);
      // Pick up collaborator edits before the agent touches anything. Taking
      // the lock here also makes the agent wait for an approve or sync that
      // was already running when this message arrived.
      // Quick: when Overleaf's project list shows no change since the last
      // full sync, one list request replaces the project download.
      try {
        const result = await withProjectLock(project.id, () => sync.syncIn(project, { quick: true }));
        if (result.detail) {
          send({
            type: "sync_warning",
            message: result.detail,
            failed: false,
            drift: result.drift,
            conflicts: result.conflicts,
          });
          persist({ type: "notice", tone: "warn", text: `Sync: ${result.detail}` });
        }
        // The open views learn which Overleaf state the mirror now holds, so
        // their "Overleaf changed" check does not fire for it.
        if (!result.skipped && result.remoteLastUpdated) {
          broadcast(project.id, { type: "remote_seen", lastSyncAt: result.lastSyncAt, remoteLastUpdated: result.remoteLastUpdated });
        }
      } catch (err: any) {
        send({ type: "sync_warning", message: err.message, failed: true });
        persist({ type: "notice", tone: "warn", text: `Sync: ${err.message}` });
      }
      // Git bridge: a sync that hit conflicts leaves <<<<<<< markers in the
      // files. The agent must never edit on top of them.
      const marked = await withProjectLock(project.id, () => sync.conflictMarkerPaths(project)).catch(() => [] as string[]);
      if (marked.length > 0) {
        notice(
          "error",
          `Not started: ${marked.join(", ")} still ${marked.length === 1 ? "contains" : "contain"} Git conflict markers (<<<<<<<) from a sync. ` +
            "Resolve them in Source (or discard those files in Proof), then send your message again.",
        );
        turn.ended = { type: "turn_end", isError: true };
        return;
      }
      // The checkpoint the turn starts from — after the sync, so undoing the
      // turn never reverts a collaborator's edits.
      let started: { n: number; sha: string } | null = null;
      try {
        started = await withProjectLock(project.id, async () => {
          const n = await freeTurnNumber(dir, chatId, countUserMessages(project.id, chatId));
          return { n, sha: await beginTurnCheckpoint(dir, chatId, n) };
        });
      } catch (err: any) {
        notice("warn", `No checkpoint for this turn (${err?.message ?? err}) — Show changes and Undo turn are unavailable for it.`);
      }
      // Wrap the sink so edits stream a live diff and per-edit file diffs mid-turn;
      // persistence taps the enriched events (tool_result carries its fileDiff).
      const turnSink = makeTurnEventSink(dir, (event) => {
        send(event);
        if (!event.live) persist(event);
      }, { workingDiff: (d) => withProjectLock(project.id, () => git.workingDiff(d)) });
      await runTurn(
        project,
        promptWithFileMentions(message, mentions),
        (event) => {
          // turn_end goes out last, with the checkpoint (see finally).
          if (event.type === "turn_end") turn.ended = { ...(turn.ended ?? {}), ...event };
          else turnSink.sink(event);
        },
        mode,
        scope,
        {
          sessionId: chat.sessionId,
          onSessionId: (sessionId) => {
            try {
              updateChat(project.id, chatId, { sessionId });
            } catch {
              /* best effort */
            }
          },
        },
        attachments,
      );
      // No live-diff timer may fire past this point; the broadcast below is authoritative.
      await turnSink.close();
      changed = beforeTurn !== (await projectFingerprint(dir));
      const start = started;
      if (start) {
        try {
          checkpoint = await withProjectLock(project.id, () => endTurnCheckpoint(dir, chatId, start.n, start.sha));
          await withProjectLock(project.id, () => pruneTurnRefs(dir)).catch(() => {});
        } catch (err: any) {
          notice("warn", `Could not record what this turn changed (${err?.message ?? err}) — Undo turn is unavailable for it.`);
        }
      }
      const stray = checkpoint ? outsideScope(checkpoint.files, scope) : [];
      if (stray.length > 0) {
        notice("warn", `This turn was limited to ${scope!.join(", ")}, but ${stray.join(", ")} changed too (through a shell command). Review them in Proof.`);
      }
      try {
        const turnDiff = await withProjectLock(project.id, () => git.workingDiff(dir));
        broadcast(project.id, { type: "diff", diff: turnDiff, changed });
      } catch (err: any) {
        send({ type: "error", message: `diff failed: ${err.message}` });
      }
    } catch (err: any) {
      // Anything thrown outside runTurn's own error handling (turn setup,
      // fingerprinting, the diff tail) must end the turn visibly — escaping
      // as an unhandled rejection would stop the whole server.
      const error = { type: "error", message: String(err?.message ?? err) };
      send(error);
      persist(error);
      failed = true;
    } finally {
      const end: Record<string, unknown> = {
        type: "turn_end",
        isError: false,
        ...(turn.ended ?? {}),
        ...(failed ? { isError: true } : {}),
        ...(checkpoint ? checkpointFields(checkpoint) : {}),
      };
      // The refresh build starts now and runs on after the turn: approve, the
      // next message and the queue no longer wait for it.
      const refresh = changed
        ? compileWorkingTree(project.id).catch((err: any) => {
            const error = { type: "error", message: String(err?.message ?? err) };
            send(error);
            persist(error);
          })
        : null;
      endTurnPipeline(project.id);
      send(end);
      persist(end);
      afterTurn(project.id, { isError: Boolean(end.isError), interrupted: Boolean(end.interrupted) });
      await refresh;
    }
  })();
}

/** The next queued message runs after a clean turn; a failed or stopped one pauses the queue. */
function afterTurn(projectId: string, outcome: { isError: boolean; interrupted: boolean }): void {
  try {
    if (outcome.interrupted) pauseQueue(projectId, "interrupted");
    else if (outcome.isError) pauseQueue(projectId, "error");
    else startNextQueued(projectId);
  } catch (err: any) {
    broadcast(projectId, { type: "error", message: `Could not start the next queued message: ${err?.message ?? err}` });
  }
}

/** Start the oldest queued message, if the project is idle and the queue runs. */
export function startNextQueued(projectId: string): boolean {
  if (isTurnActive(projectId)) return false;
  for (;;) {
    const next = takeNextQueued(projectId);
    if (!next) return false;
    const project = getProject(projectId);
    if (!project) {
      clearQueue(projectId);
      return false;
    }
    if (!getChat(projectId, next.chatId)) {
      broadcast(projectId, { type: "notice", tone: "warn", text: "A queued message was dropped: its chat no longer exists." });
      continue;
    }
    startTurn(project, next.request, { fromQueue: true });
    return true;
  }
}
