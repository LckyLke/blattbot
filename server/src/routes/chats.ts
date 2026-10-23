// Chats, AI-use disclosure, starting a turn (see turn-runner.ts), interrupt,
// and answers to mid-turn questions.
import type { FastifyInstance } from "fastify";
import { resolveFileMentions } from "../file-mentions.js";
import { getProject, projectDir, updateProject } from "../config.js";
import {
  AGENT_MODES,
  deleteSessionData,
  interruptTurn,
  isTurnActive,
  runOneShot,
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
import {
  createChat,
  deleteChat,
  ensureActiveChat,
  getChat,
  listChats,
  publicChat,
  readTranscript,
  referencedImageIds,
  setActiveChat,
} from "../chats.js";
import { pruneOrphanChatUploads, resolveAttachments, type TurnAttachment } from "../chatimages.js";
import { startTurn } from "../turn-runner.js";

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

      startTurn(project, { message, mode, scope, mentions, attachments });

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
