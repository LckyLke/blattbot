// Chats, AI-use disclosure, starting a turn, interrupt, and answers to
// mid-turn questions.
import type { FastifyInstance } from "fastify";
import { promptWithFileMentions, resolveFileMentions } from "../file-mentions.js";
import { getProject, projectDir, updateProject } from "../config.js";
import * as git from "../git.js";
import { projectFingerprint } from "../project-fingerprint.js";
import { compileProject } from "../compile.js";
import {
  AGENT_MODES,
  beginTurnPipeline,
  deleteSessionData,
  endTurnPipeline,
  interruptTurn,
  isTurnActive,
  runOneShot,
  runTurn,
  validateScope,
  type AgentMode,
} from "../agent.js";
import { collectDisclosureFacts, composeDisclosure } from "../disclosure.js";
import {
  answerQuestion,
  dismissQuestion,
  pendingQuestion,
  questionStatus,
  validateAnswers,
} from "../questions.js";
import { broadcast } from "../events.js";
import {
  appendEvent,
  createChat,
  deleteChat,
  ensureActiveChat,
  getChat,
  listChats,
  publicChat,
  readTranscript,
  referencedImageIds,
  setActiveChat,
  updateChat,
} from "../chats.js";
import { makeTurnEventSink } from "../livediff.js";
import { withProjectLock } from "../project-lock.js";
import * as sync from "../sync.js";
import { pruneOrphanChatUploads, resolveAttachments, type TurnAttachment } from "../chatimages.js";
import { compilePublic, lastCompile } from "../app-state.js";

/** Per project, when the last orphan sweep ran (see sweepChatUploads). */
const lastUploadSweep = new Map<string, number>();
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Drop chat-image files no transcript references. Images are stored before the
 * message is posted, so every send that never completes (409 "turn in
 * progress", a closed tab, a rejected message, a failed sibling upload) leaves
 * one behind that nothing can reach. Runs opportunistically when a project's
 * chat list is fetched — that covers project open — and at most once every
 * SWEEP_INTERVAL_MS per project, so the transcript scan stays off the hot path.
 * Failures are swallowed: housekeeping must never break a request.
 */
function sweepChatUploads(projectId: string): void {
  const now = Date.now();
  const last = lastUploadSweep.get(projectId) ?? 0;
  if (now - last < SWEEP_INTERVAL_MS) return;
  lastUploadSweep.set(projectId, now);
  try {
    pruneOrphanChatUploads(projectId, referencedImageIds(projectId), now);
  } catch {
    /* never fatal */
  }
}

export function registerChatRoutes(app: FastifyInstance): void {
  // ---- Chats: persistent per-project conversations ---------------------------

  app.get<{ Params: { id: string } }>("/api/projects/:id/chats", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const active = ensureActiveChat(project.id);
    // Project open (and every chat-list refresh) is the cheap, natural moment to
    // collect uploads whose send never happened.
    sweepChatUploads(project.id);
    return { chats: listChats(project.id).map(publicChat), activeChatId: active.id };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/chats", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    // Creating also activates — same hazard as /activate while a turn streams.
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const chat = createChat(project.id);
    updateProject(project.id, { activeChatId: chat.id });
    return publicChat(chat);
  });

  app.post<{ Params: { id: string; chatId: string } }>(
    "/api/projects/:id/chats/:chatId/activate",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const chat = setActiveChat(project.id, req.params.chatId);
      if (!chat) return reply.code(404).send({ error: "unknown chat" });
      return { ok: true, activeChatId: chat.id };
    },
  );

  app.get<{ Params: { id: string; chatId: string } }>(
    "/api/projects/:id/chats/:chatId/transcript",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (!getChat(project.id, req.params.chatId)) return reply.code(404).send({ error: "unknown chat" });
      return { events: readTranscript(project.id, req.params.chatId) };
    },
  );

  app.delete<{ Params: { id: string; chatId: string } }>(
    "/api/projects/:id/chats/:chatId",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const sessionId = getChat(project.id, req.params.chatId)?.sessionId;
      if (!deleteChat(project.id, req.params.chatId)) return reply.code(404).send({ error: "unknown chat" });
      // The OpenAI-compatible backend keeps the full conversation text on disk.
      if (sessionId) deleteSessionData(sessionId);
      // If the active chat went away this reactivates the newest remaining
      // conversation, or creates a fresh one when none is left.
      const active = ensureActiveChat(project.id);
      return { ok: true, chats: listChats(project.id).map(publicChat), activeChatId: active.id };
    },
  );

  // AI-use disclosure: deterministic facts from the stored chats, composed into
  // a factual paragraph; the agent may polish the phrasing, but any failure
  // falls back to the deterministic text — the endpoint itself never fails on it.
  app.post<{ Params: { id: string } }>("/api/projects/:id/disclosure", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const facts = collectDisclosureFacts(project.id);
    let text = composeDisclosure(project.name, facts);
    if (facts.turns > 0) {
      try {
        const polished = await runOneShot(
          "Polish the phrasing of this AI-use disclosure statement for an academic paper. " +
            "Keep every fact, number, and name exactly as stated, keep it to one short factual " +
            "paragraph, and use no puffery. Reply with only the revised paragraph.\n\n" +
            text,
        );
        if (polished.trim()) text = polished.trim();
      } catch {
        /* the deterministic paragraph stands */
      }
    }
    return { text, facts };
  });

  app.post<{
    Params: { id: string };
    Body: { message: string; mode?: string; files?: string[]; images?: string[]; mentions?: unknown };
  }>(
    "/api/projects/:id/chat",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const message = req.body?.message?.trim() ?? "";
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn already in progress" });
      // Attached images: ids from POST …/chat-image, resolved back to the files
      // stored outside the working tree.
      let attachments: TurnAttachment[];
      try {
        attachments = resolveAttachments(project.id, req.body?.images);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      let mentions;
      try {
        mentions = await resolveFileMentions(project.id, req.body?.mentions, message);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn already in progress" });
      // "Here's a screenshot" with no words is the most natural way to use a
      // paste-an-image composer, so pictures alone are a complete message; the
      // attachment note the prompt carries tells the agent what it is looking at.
      if (!message && attachments.length === 0) {
        return reply.code(400).send({ error: "message is required" });
      }
      const mode: AgentMode = AGENT_MODES.some((m) => m.id === req.body?.mode)
        ? (req.body!.mode as AgentMode)
        : "edit";
      let scope: string[] | undefined;
      if (req.body?.files !== undefined) {
        try {
          const validated = validateScope(projectDir(project.id), req.body.files);
          if (validated.length > 0) scope = validated;
        } catch (err: any) {
          return reply.code(400).send({ error: err.message });
        }
      }

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

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/interrupt", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const interrupted = interruptTurn(project.id);
    return { ok: true, interrupted };
  });

  // ---- Mid-turn questions (AskUserQuestion / ask_user) -----------------------
  // Answer the pending question: body maps each question's TEXT to the chosen
  // answer string (multi-select answers comma-joined; free-text is any string).
  app.post<{ Params: { id: string; questionId: string }; Body: { answers?: Record<string, string> } }>(
    "/api/projects/:id/question/:questionId",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      // The answers validate AGAINST the pending question (keys must be its
      // question texts) — resolve the id's status first so an unknown or
      // already-settled id still gets its 404/410 regardless of the body.
      const pending = pendingQuestion(project.id);
      if (!pending || pending.questionId !== req.params.questionId) {
        if (questionStatus(project.id, req.params.questionId) === "resolved") {
          return reply.code(410).send({ error: "that question was already answered or dismissed" });
        }
        return reply.code(404).send({ error: "no such pending question" });
      }
      let answers: Record<string, string>;
      try {
        answers = validateAnswers(req.body?.answers, pending.questions);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      const outcome = answerQuestion(project.id, req.params.questionId, answers);
      if (outcome === "unknown") return reply.code(404).send({ error: "no such pending question" });
      if (outcome === "resolved") {
        return reply.code(410).send({ error: "that question was already answered or dismissed" });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; questionId: string } }>(
    "/api/projects/:id/question/:questionId/dismiss",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const outcome = dismissQuestion(project.id, req.params.questionId);
      if (outcome === "unknown") return reply.code(404).send({ error: "no such pending question" });
      if (outcome === "resolved") {
        return reply.code(410).send({ error: "that question was already answered or dismissed" });
      }
      return { ok: true };
    },
  );
}
