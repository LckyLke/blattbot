// Review flow: working diff, sync from Overleaf, publish, approve (whole or
// partial), reject (all, one file, one hunk), and the commit log.
import type { FastifyInstance } from "fastify";
import { resolve, sep } from "node:path";
import { getProject, projectDir, publicProject } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";
import { OverleafAuthError } from "../overleaf/olclient.js";
import * as sync from "../sync.js";
import { getAccount, updateAccount } from "../accounts.js";
import { diffPaths } from "../http-helpers.js";
import * as history from "../history.js";

export function registerReviewRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/diff", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const diff = await withProjectLock(project.id, () => git.workingDiff(projectDir(project.id)));
    return { diff };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/sync", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    try {
      const result = await withProjectLock(project.id, () => sync.syncIn(project));
      broadcast(project.id, {
        type: "synced",
        detail: result.detail,
        merged: result.merged,
        rebased: result.rebased,
        drift: result.drift,
        conflicts: result.conflicts,
        lastSyncAt: result.lastSyncAt,
        remoteLastUpdated: result.remoteLastUpdated,
      });
      return {
        ok: true,
        output: result.detail ?? "",
        changed: result.changed ?? false,
        merged: result.merged ?? [],
        rebased: result.rebased ?? [],
        drift: result.drift ?? [],
        conflicts: result.conflicts ?? [],
        ...(result.lastSyncAt ? { lastSyncAt: result.lastSyncAt } : {}),
        ...(result.remoteLastUpdated ? { remoteLastUpdated: result.remoteLastUpdated } : {}),
      };
    } catch (err: any) {
      return reply.code(422).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { accountId?: string } }>(
    "/api/projects/:id/publish",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (project.kind !== "local") {
        return reply.code(400).send({ error: "only local projects can be published to Overleaf" });
      }
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const account = getAccount(req.body?.accountId ?? "");
      if (!account) return reply.code(404).send({ error: "unknown account" });
      try {
        const result = await withProjectLock(project.id, () => sync.publishLocal(project, account));
        broadcast(project.id, {
          type: "published",
          project: publicProject(result.project),
          uploaded: result.uploaded,
          warnings: result.warnings,
        });
        return {
          project: publicProject(result.project),
          uploaded: result.uploaded,
          warnings: result.warnings,
        };
      } catch (err: any) {
        if (err instanceof OverleafAuthError) {
          updateAccount(account.id, { status: "disconnected" });
          return reply.code(401).send({
            error: `The ${new URL(account.baseUrl).hostname} session has expired — reconnect the account.`,
          });
        }
        return reply.code(422).send({ error: `Publish failed: ${err.message}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { message?: string; force?: boolean; forcePaths?: unknown; selection?: { files?: unknown; patches?: unknown } };
  }>(
    "/api/projects/:id/approve",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const message = req.body?.message?.trim() || "BlattBot edit";
      // Partial approval: whole files and/or single hunks of the working diff.
      let selection: sync.ApproveSelection | undefined;
      const strings = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === "string" && x.length > 0);
      if (req.body?.selection !== undefined) {
        const { files = [], patches = [] } = req.body.selection ?? {};
        if (!strings(files) || !strings(patches)) {
          return reply.code(400).send({ error: "selection must list files and/or patches" });
        }
        selection = { files: files as string[], patches: patches as string[] };
      }
      // Overwrite Overleaf for these conflicting files only.
      const forcePaths = req.body?.forcePaths;
      if (forcePaths !== undefined && !strings(forcePaths)) {
        return reply.code(400).send({ error: "forcePaths must list files" });
      }
      const dir = projectDir(project.id);
      try {
        const { result, remaining, notes, chatId } = await withProjectLock(project.id, async () => {
          // Trailers record what kind of commit this is and which chat it came from.
          const plan = await history.planApproval(project, selection);
          const result = await sync.approve(project, history.withTrailers(message, plan.trailers), {
            force: req.body?.force === true,
            forcePaths: forcePaths as string[] | undefined,
            selection,
          });
          const notes = await history.finishApproval(project, plan, result);
          // What is still pending: the unapproved rest, or files that failed to upload.
          const remaining = selection || result.pending ? await git.workingDiff(dir) : null;
          return { result, remaining, notes, chatId: plan.chatId };
        });
        const approved = {
          type: "approved",
          pushed: result.pushed,
          uploaded: result.uploaded,
          deleted: result.deleted,
          warnings: result.warnings,
          absorbedRemote: result.absorbedRemote,
          mergedRemote: result.mergedRemote,
          drift: result.drift,
          conflicts: result.conflicts,
          remoteLastUpdated: result.remoteLastUpdated,
          ...(result.historyLabel ? { historyLabel: result.historyLabel } : {}),
          ...(selection ? { partial: true } : {}),
          projectKind: project.kind,
          ...notes,
        };
        broadcast(project.id, approved);
        // Persisted too, so the outcome is still in the chat after a reload.
        history.recordChatEvent(project.id, approved, chatId);
        // "approved" clears the review; whatever is left stays in it.
        if (remaining !== null) broadcast(project.id, { type: "diff", diff: remaining, changed: false });
        return { ok: true, ...result, ...(remaining !== null ? { diff: remaining } : {}) };
      } catch (err: any) {
        // Remote drift touching locally edited files: nothing was committed or
        // pushed — the UI offers per-file discard or an explicit force.
        if (err instanceof sync.ApproveConflictError) {
          return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
        }
        if (err instanceof sync.SelectionError) return reply.code(409).send({ error: err.message });
        if (err instanceof history.HistoryError) return reply.code(err.status).send({ error: err.message });
        return reply.code(422).send({ error: err.message });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/reject", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    await withProjectLock(project.id, () => git.discard(projectDir(project.id)));
    broadcast(project.id, { type: "rejected" });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    "/api/projects/:id/reject-file",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const rel = (req.body?.path ?? "").trim();
      if (!rel) return reply.code(400).send({ error: "path is required" });
      const dir = projectDir(project.id);
      const abs = resolve(dir, rel);
      if (abs === dir || !abs.startsWith(dir + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }
      const diff = await withProjectLock(project.id, async () => {
        if (!diffPaths(await git.workingDiff(dir)).has(rel)) return null;
        await git.discardPath(dir, rel);
        return git.workingDiff(dir);
      });
      if (diff === null) {
        return reply.code(409).send({ error: "that file has no pending changes — refresh the proof" });
      }
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, diff };
    },
  );

  app.post<{ Params: { id: string }; Body: { patch?: string } }>(
    "/api/projects/:id/reject-hunk",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const patch = req.body?.patch ?? "";
      if (!patch.trim()) return reply.code(400).send({ error: "patch is required" });
      const dir = projectDir(project.id);
      const diff = await withProjectLock(project.id, async () => {
        try {
          await git.applyReverse(dir, patch);
        } catch {
          return null;
        }
        return git.workingDiff(dir);
      });
      if (diff === null) return reply.code(409).send({ error: "hunk no longer applies — refresh the proof" });
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, diff };
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/log", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const log = await git.log(projectDir(project.id)).catch(() => "");
    return { log };
  });
}
