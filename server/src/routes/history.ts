// History: the commit timeline (from Overleaf / pushed by you / local),
// one commit's diff, force-approve backups, and reverting a commit as new
// pending changes for the Proof.
import type { FastifyInstance, FastifyReply } from "fastify";
import { getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";
import { looksBinary } from "../merge.js";
import * as history from "../history.js";

const SHA = /^[0-9a-f]{4,64}$/i;

function fail(reply: FastifyReply, err: any) {
  if (err instanceof history.HistoryError) return reply.code(err.status).send({ error: err.message });
  return reply.code(422).send({ error: String(err?.message ?? err) });
}

/** What the client needs to know about reverts waiting in the Proof. */
function revertSummary(reverts: history.PendingRevert[]) {
  if (reverts.length === 0) return null;
  return {
    commits: reverts.map((r) => ({ sha: r.sha, short: r.short, subject: r.subject })),
    paths: [...new Set(reverts.flatMap((r) => r.paths))],
    message: history.revertMessage(reverts),
  };
}

export function registerHistoryRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; head?: string; filter?: string } }>(
    "/api/projects/:id/history",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const { limit, offset, head, filter } = req.query ?? {};
      if (head && !SHA.test(head)) return reply.code(400).send({ error: "invalid head" });
      try {
        const page = await history.listHistory(project, {
          limit: Number(limit) || undefined,
          offset: Number(offset) || 0,
          head: head || undefined,
          filter: filter === "sync" || filter === "mine" ? filter : "all",
        });
        const reverts = await history.pendingReverts(projectDir(project.id));
        return { ...page, pendingRevert: revertSummary(reverts) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // The History tab's unread badge: Overleaf/remote commits after `since`.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/projects/:id/history/status",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const since = req.query?.since;
      try {
        const status = await history.unreadSince(project, since && SHA.test(since) ? since : undefined);
        const reverts = await history.pendingReverts(projectDir(project.id));
        return { ...status, pendingRevert: revertSummary(reverts) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/history/backups", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return { backups: history.listBackups(projectDir(project.id)) };
  });

  // One backed-up file. Served as plain text or bytes, never as a page.
  app.get<{ Params: { id: string; stamp: string }; Querystring: { path?: string; download?: string } }>(
    "/api/projects/:id/history/backups/:stamp/file",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const path = req.query?.path ?? "";
      const content = history.readBackupFile(projectDir(project.id), req.params.stamp, path);
      if (!content) return reply.code(404).send({ error: "no such backup file" });
      const download = req.query?.download === "1";
      const name = encodeURIComponent(path.split("/").pop() || "backup");
      reply.header(
        "Content-Type",
        download || looksBinary(content) ? "application/octet-stream" : "text/plain; charset=utf-8",
      );
      reply.header("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      return reply.send(content);
    },
  );

  app.get<{ Params: { id: string; sha: string } }>("/api/projects/:id/history/:sha", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (!SHA.test(req.params.sha)) return reply.code(400).send({ error: "invalid commit id" });
    try {
      return await history.commitDetail(project, req.params.sha);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Revert = the reverse of a commit as NEW PENDING changes: nothing is
  // committed or pushed here; the Proof reviews and approves it as usual.
  app.post<{ Params: { id: string; sha: string } }>("/api/projects/:id/history/:sha/revert", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (!SHA.test(req.params.sha)) return reply.code(400).send({ error: "invalid commit id" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const dir = projectDir(project.id);
    try {
      const { result, diff } = await withProjectLock(project.id, async () => {
        const result = await history.revertCommit(project, req.params.sha);
        return { result, diff: await git.workingDiff(dir) };
      });
      if (result.changed.length > 0) {
        broadcast(project.id, { type: "diff", diff, changed: true });
        const notices = [
          {
            type: "notice",
            tone: "info",
            text: `Reverted ${result.short} "${result.subject}" as pending changes to ${result.changed.join(", ")} — review and approve them in Proof.`,
          },
          ...(result.conflicts.length > 0
            ? [
                {
                  type: "notice",
                  tone: "warn",
                  text: `Revert of ${result.short} needs attention: ${result.conflicts.map((c) => `${c.path} (${c.reason})`).join("; ")}`,
                },
              ]
            : []),
        ];
        for (const notice of notices) {
          broadcast(project.id, notice);
          history.recordChatEvent(project.id, notice);
        }
      }
      return { ok: true, ...result, diff };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
