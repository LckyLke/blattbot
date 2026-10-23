// Per-file resolution of files both Overleaf and the local tree changed:
// keep Overleaf's version, or write the line merge with conflict markers
// into the file to finish by hand. ("Overwrite Overleaf" is a forced
// approve of that file, see review.ts.)
import type { FastifyInstance } from "fastify";
import { resolve, sep } from "node:path";
import { getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";
import * as sync from "../sync.js";

export function registerConflictRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { paths?: unknown; keep?: unknown } }>(
    "/api/projects/:id/conflicts/resolve",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (project.kind !== "overleaf") return reply.code(400).send({ error: "only Overleaf projects have Overleaf versions to keep" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const keep = req.body?.keep;
      if (keep !== "overleaf" && keep !== "markers") {
        return reply.code(400).send({ error: 'keep must be "overleaf" or "markers"' });
      }
      const paths = req.body?.paths;
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500 || !paths.every((p) => typeof p === "string" && p.length > 0)) {
        return reply.code(400).send({ error: "paths must list files" });
      }
      const dir = projectDir(project.id);
      for (const rel of paths as string[]) {
        const abs = resolve(dir, rel);
        if (abs === dir || !abs.startsWith(dir + sep) || rel.split("/").includes(".git")) {
          return reply.code(400).send({ error: "invalid path" });
        }
      }
      try {
        const { resolved, diff } = await withProjectLock(project.id, async () => {
          const resolved = await sync.resolveConflicts(project, [...new Set(paths as string[])], keep);
          return { resolved, diff: await git.workingDiff(dir) };
        });
        broadcast(project.id, { type: "diff", diff });
        return { ok: true, resolved, diff };
      } catch (err: any) {
        return reply.code(422).send({ error: err.message });
      }
    },
  );
}
