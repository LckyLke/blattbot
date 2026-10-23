// The agent-turn pipeline behind POST /api/projects/:id/chat: pre-turn sync,
// the backend turn with its live-diff event sink, the authoritative diff,
// the post-turn recompile, transcript persistence and the broadcasts.
import { promptWithFileMentions, type FileMention } from "./file-mentions.js";
import { projectDir, type Project } from "./config.js";
import * as git from "./git.js";
import { projectFingerprint } from "./project-fingerprint.js";
import { compileProject } from "./compile.js";
import { beginTurnPipeline, endTurnPipeline, runTurn, type AgentMode } from "./agent.js";
import { broadcast } from "./events.js";
import { appendEvent, ensureActiveChat, updateChat } from "./chats.js";
import { makeTurnEventSink } from "./livediff.js";
import { withProjectLock } from "./project-lock.js";
import * as sync from "./sync.js";
import type { TurnAttachment } from "./chatimages.js";
import { compilePublic, lastCompile } from "./app-state.js";

/** A validated chat message, ready to run as an agent turn. */
export interface TurnRequest {
  /** Trimmed message text; empty when the message is images only. */
  message: string;
  mode: AgentMode;
  /** Files the turn is limited to; undefined = the whole project. */
  scope?: string[];
  mentions: FileMention[];
  attachments: TurnAttachment[];
}

/**
 * Start an agent turn on the project's active chat and return once it runs.
 *
 * The user message is persisted and the project is marked busy
 * (isTurnActive) synchronously, before this returns — so a caller that has
 * just checked isTurnActive must not await between that check and this call.
 * Everything else runs in the background and reports over the websocket.
 */
export function startTurn(project: Project, request: TurnRequest): void {
  const { message, mode, scope, mentions, attachments } = request;
  // The message goes to the project's active chat; the turn resumes that
  // chat's own session and every UI-relevant event is persisted to it.
  const activeChat = ensureActiveChat(project.id);
  const chatId = activeChat.id;
  try {
    appendEvent(project.id, chatId, {
      type: "user_message",
      text: message,
      ...(mentions.length ? { mentions } : {}),
      mode,
      ...(scope ? { scope } : {}),
      // id + mime is all the restored transcript needs to render a thumbnail.
      ...(attachments.length > 0
        ? { attachments: attachments.map((a) => ({ id: a.id, mime: a.mime })) }
        : {}),
    });
  } catch {
    /* persistence must never block the turn */
  }
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

  // Run the turn in the background; progress streams over the websocket.
  // isTurnActive (the 409 guards, the polled turnActive field) must stay
  // true for this whole pipeline, not just the backend call inside runTurn —
  // otherwise a second /chat can start while the diff/recompile tail below
  // is still touching the same working tree.
  beginTurnPipeline(project.id);
  void (async () => {
    let turnEnded = false;
    try {
      broadcast(project.id, { type: "turn_start" });
      const beforeTurn = await projectFingerprint(projectDir(project.id));
      // Pick up collaborator edits before the agent touches anything. Taking
      // the lock here also makes the agent wait for an approve or sync that
      // was already running when this message arrived.
      try {
        const result = await withProjectLock(project.id, () => sync.syncIn(project));
        if (result.detail) {
          broadcast(project.id, { type: "sync_warning", message: result.detail, failed: false, drift: result.drift });
          persist({ type: "notice", tone: "warn", text: `Sync: ${result.detail}` });
        }
      } catch (err: any) {
        broadcast(project.id, { type: "sync_warning", message: err.message, failed: true });
        persist({ type: "notice", tone: "warn", text: `Sync: ${err.message}` });
      }
      // Wrap the sink so edits stream a live diff and per-edit file diffs mid-turn;
      // persistence taps the enriched events (tool_result carries its fileDiff).
      const turnSink = makeTurnEventSink(projectDir(project.id), (event) => {
        broadcast(project.id, event);
        if (!event.live) persist(event);
      }, { workingDiff: (dir) => withProjectLock(project.id, () => git.workingDiff(dir)) });
      await runTurn(
        project,
        promptWithFileMentions(message, mentions),
        turnSink.sink,
        mode,
        scope,
        {
          sessionId: activeChat.sessionId,
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
      turnEnded = true;
      // No live-diff timer may fire past this point; the broadcast below is authoritative.
      await turnSink.close();
      const changed = beforeTurn !== await projectFingerprint(projectDir(project.id));
      let turnDiff = "";
      try {
        turnDiff = await withProjectLock(project.id, () => git.workingDiff(projectDir(project.id)));
        broadcast(project.id, { type: "diff", diff: turnDiff, changed });
      } catch (err: any) {
        broadcast(project.id, { type: "error", message: `diff failed: ${err.message}` });
      }
      // Refresh the PDF preview — but only when the turn actually changed
      // something; a purely conversational message needs no recompile.
      if (changed) {
        broadcast(project.id, { type: "compile_start" });
        const result = await compileProject(project.id, projectDir(project.id), project.mainTex);
        lastCompile.set(project.id, result);
        broadcast(project.id, { type: "compile", ...compilePublic(result) });
      }
    } catch (err: any) {
      // Anything thrown outside runTurn's own error handling (turn setup,
      // fingerprinting, the diff/recompile tail) must end the turn visibly —
      // escaping as an unhandled rejection would stop the whole server.
      const error = { type: "error", message: String(err?.message ?? err) };
      broadcast(project.id, error);
      persist(error);
      if (!turnEnded) {
        const end = { type: "turn_end", isError: true };
        broadcast(project.id, end);
        persist(end);
      }
    } finally {
      endTurnPipeline(project.id);
    }
  })();
}
