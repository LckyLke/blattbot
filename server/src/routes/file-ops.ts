// Create, rename/move and delete project files (the Source panel's file
// actions). Same rules as a manual save: inside the working tree only, under
// the project lock, never while an agent turn runs. The results are pending
// changes like any other edit — reviewed in Proof, pushed only on approval.
import type { FastifyInstance, FastifyReply } from "fastify";
import { getProject, projectDir, updateProject, type Project } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { withProjectLock } from "../project-lock.js";
import { broadcast } from "../events.js";
import { findMainTex, listFiles, mainTexCandidates } from "../latex.js";
import { FileOpError, createProjectFile, deleteProjectFile, renameProjectFile } from "../project-files.js";

const TURN_ACTIVE = "agent turn in progress — file changes wait until it ends";

class TurnActive extends Error {}

/** Run one file operation for a project and answer with the fresh diff and file list. */
async function fileOp<T extends object>(
  id: string,
  reply: FastifyReply,
  op: (project: Project, dir: string) => T,
) {
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  if (isTurnActive(project.id)) return reply.code(409).send({ error: TURN_ACTIVE });
  const dir = projectDir(project.id);
  try {
    const result = await withProjectLock(project.id, async () => {
      // A turn may have started while this request waited for the lock.
      if (isTurnActive(project.id)) throw new TurnActive();
      const out = op(project, dir);
      const diff = await git.workingDiff(dir).catch(() => "");
      return { ...out, diff };
    });
    broadcast(project.id, { type: "diff", diff: result.diff });
    return { ok: true, ...result, files: listFiles(dir) };
  } catch (err) {
    if (err instanceof TurnActive) return reply.code(409).send({ error: TURN_ACTIVE });
    if (err instanceof FileOpError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function registerFileOpRoutes(app: FastifyInstance): void {
  // Main-file choices for the project settings: .tex files with a
  // \documentclass, plus the current main file whatever it is.
  app.get<{ Params: { id: string } }>("/api/projects/:id/main-files", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const candidates = mainTexCandidates(projectDir(project.id));
    if (project.mainTex && !candidates.includes(project.mainTex)) candidates.unshift(project.mainTex);
    return { mainTex: project.mainTex ?? null, chosen: Boolean(project.mainTexChosen), candidates };
  });

  // New file, empty or with content; missing folders on its path are created.
  app.post<{ Params: { id: string }; Body: { path?: unknown; content?: unknown } }>(
    "/api/projects/:id/files",
    async (req, reply) =>
      fileOp(req.params.id, reply, (_project, dir) => ({
        path: createProjectFile(dir, req.body?.path, req.body?.content ?? ""),
      })),
  );

  // Rename or move a file. The main file keeps its role under its new name.
  app.post<{ Params: { id: string }; Body: { from?: unknown; to?: unknown } }>(
    "/api/projects/:id/files/rename",
    async (req, reply) =>
      fileOp(req.params.id, reply, (project, dir) => {
        const { from, to } = renameProjectFile(dir, req.body?.from, req.body?.to);
        if (project.mainTex === from) updateProject(project.id, { mainTex: to });
        return { path: to, from };
      }),
  );

  // Delete a file. Deleting the main file falls back to detecting one.
  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/files",
    async (req, reply) =>
      fileOp(req.params.id, reply, (project, dir) => {
        const path = deleteProjectFile(dir, req.query.path);
        if (project.mainTex === path) {
          updateProject(project.id, { mainTex: findMainTex(dir), mainTexChosen: undefined });
        }
        return { path };
      }),
  );
}
