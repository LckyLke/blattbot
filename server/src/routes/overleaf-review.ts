// Overleaf review comments: list the co-authors' comment threads and tracked
// changes, and (user-triggered only) reply to, resolve and reopen threads.
// The agent has a read-only tool for the list; it can never reach these POSTs.
import type { FastifyInstance, FastifyReply } from "fastify";
import { getProject, projectDir, type Project } from "../config.js";
import {
  buildReview,
  refreshCachedThreads,
  remoteReview,
  type OverleafReview,
} from "../overleaf/comments.js";
import { OverleafFeatureError, OverleafPermissionError } from "../overleaf/olclient.js";
import { withSession } from "../sync.js";

/** Overleaf's own comment box takes long texts; anything above this is a mistake. */
const MAX_REPLY = 10_000;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

function overleafProject(id: string, reply: FastifyReply): Project | null {
  const project = getProject(id);
  if (!project) {
    reply.code(404).send({ error: "unknown project" });
    return null;
  }
  if (project.kind !== "overleaf" || !project.overleafProjectId) {
    reply.code(400).send({
      error: "Overleaf comments are only available for projects synced with Overleaf through an account (not git or local projects).",
    });
    return null;
  }
  return project;
}

/** A failure as an HTTP answer: Overleaf's 404/403 keep their meaning; the rest is 422. */
function sendFailure(reply: FastifyReply, err: any) {
  if (err instanceof OverleafFeatureError) return reply.code(404).send({ error: err.message });
  if (err instanceof OverleafPermissionError) return reply.code(403).send({ error: err.message });
  return reply.code(422).send({ error: String(err?.message ?? err) });
}

async function currentReview(project: Project, refresh: boolean): Promise<OverleafReview> {
  const remote = await remoteReview(project.id, project.overleafProjectId!, (fn) => withSession(project, fn), refresh);
  return buildReview(remote, projectDir(project.id));
}

export function registerOverleafReviewRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/projects/:id/overleaf/comments",
    async (req, reply) => {
      const project = overleafProject(req.params.id, reply);
      if (!project) return;
      try {
        return await currentReview(project, req.query.refresh === "1" || req.query.refresh === "true");
      } catch (err: any) {
        return sendFailure(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; threadId: string }; Body: { content?: unknown } }>(
    "/api/projects/:id/overleaf/threads/:threadId/messages",
    async (req, reply) => {
      const project = overleafProject(req.params.id, reply);
      if (!project) return;
      const { threadId } = req.params;
      if (!THREAD_ID.test(threadId)) return reply.code(400).send({ error: "invalid thread id" });
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      if (!content) return reply.code(400).send({ error: "Write a reply first." });
      if (content.length > MAX_REPLY) return reply.code(400).send({ error: `The reply is too long — the limit is ${MAX_REPLY} characters.` });
      try {
        await withSession(project, (client) => client.postThreadMessage(project.overleafProjectId!, threadId, content));
        await refreshCachedThreads(project.id, project.overleafProjectId!, (fn) => withSession(project, fn));
        return await currentReview(project, false);
      } catch (err: any) {
        return sendFailure(reply, err);
      }
    },
  );

  for (const action of ["resolve", "reopen"] as const) {
    app.post<{ Params: { id: string; threadId: string } }>(
      `/api/projects/:id/overleaf/threads/:threadId/${action}`,
      async (req, reply) => {
        const project = overleafProject(req.params.id, reply);
        if (!project) return;
        const { threadId } = req.params;
        if (!THREAD_ID.test(threadId)) return reply.code(400).send({ error: "invalid thread id" });
        try {
          // The doc the comment sits in comes from the review state, not the client.
          const thread = (await currentReview(project, false)).threads.find((t) => t.id === threadId);
          if (!thread) {
            return reply.code(404).send({ error: "That comment is no longer on Overleaf — refresh the list." });
          }
          await withSession(project, (client) =>
            client.setThreadResolved(project.overleafProjectId!, thread.docId, threadId, action === "resolve"),
          );
          await refreshCachedThreads(project.id, project.overleafProjectId!, (fn) => withSession(project, fn));
          return await currentReview(project, false);
        } catch (err: any) {
          return sendFailure(reply, err);
        }
      },
    );
  }
}
