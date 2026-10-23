// Local compile, Verify on Overleaf, per-revision builds, PDF serving, and
// the PDF-text to source locator.
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDir, getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import { compileRev, revPdfPath } from "../compile.js";
import { compileWorkingTree, getLastCompile, publicCompile } from "../compile-service.js";
import { listFiles } from "../latex.js";
import { locateInSources } from "../locate.js";
import * as sync from "../sync.js";
import { lastRemoteCompile } from "../app-state.js";

export function registerCompileRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>("/api/projects/:id/compile", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    // Unchanged sources reuse the last successful build unless forced (Recompile).
    try {
      return publicCompile(await compileWorkingTree(project.id, { force: req.body?.force === true }));
    } catch (err: any) {
      return reply.code(422).send({ error: `Compile failed: ${err?.message ?? err}` });
    }
  });

  // Verify on Overleaf: run the remote instance's own compiler on the project's
  // CURRENT REMOTE state (approved & pushed — never unpushed local edits). A
  // failed build is a *result*, not a server error: 200 with the remote log tail.
  app.post<{ Params: { id: string } }>("/api/projects/:id/remote-compile", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.kind !== "overleaf") {
      return reply.code(400).send({ error: "remote compile is only available for Overleaf cookie-mode projects" });
    }
    try {
      const result = await sync.remoteCompile(project);
      if (!result.pdf) {
        return { status: result.status, pdf: false, logTail: result.logTail ?? "" };
      }
      mkdirSync(buildDir(project.id), { recursive: true });
      const pdfPath = join(buildDir(project.id), "remote.pdf");
      writeFileSync(pdfPath, result.pdf);
      lastRemoteCompile.set(project.id, pdfPath);
      return { status: result.status, pdf: true };
    } catch (err: any) {
      return reply.code(422).send({ error: err.message });
    }
  });

  // Rendered-diff support: compile the project's state AS COMMITTED at a rev
  // (only HEAD — the approval base — for now) into a per-sha build cache. The
  // pdf route serves the cached build via ?rev=<sha>. A failed build is a
  // result, not a server error: 200 with the log tail.
  app.post<{ Params: { id: string }; Body: { rev?: string } }>(
    "/api/projects/:id/compile-rev",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if ((req.body?.rev ?? "HEAD") !== "HEAD") {
        return reply.code(400).send({ error: 'only rev "HEAD" is supported' });
      }
      const dir = projectDir(project.id);
      try {
        const sha = await git.revParse(dir, "HEAD");
        const result = await compileRev(project.id, dir, sha, project.mainTex);
        if (!result.ok) return { ok: false, sha, log: result.logTail };
        return { ok: true, sha };
      } catch (err: any) {
        return reply.code(422).send({ error: err.message });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { source?: string; rev?: string } }>(
    "/api/projects/:id/pdf",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const safeName = project.name.replace(/[^\w. -]+/g, "_") || "project";
      // ?rev=<sha> serves the cached build of that committed revision (made by
      // POST /compile-rev — the rendered diff's approval-base PDF). The hex-only
      // check doubles as the path-traversal guard.
      if (req.query.rev) {
        if (!/^[0-9a-f]{7,40}$/.test(req.query.rev)) {
          return reply.code(400).send({ error: "invalid rev" });
        }
        const revPath = revPdfPath(project.id, req.query.rev);
        if (!existsSync(revPath)) {
          return reply.code(404).send({ error: "no cached build for that revision — compile it first" });
        }
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Disposition", `inline; filename="${safeName}-${req.query.rev.slice(0, 7)}.pdf"`);
        return reply.type("application/pdf").send(createReadStream(revPath));
      }
      // ?source=remote serves the last "Verify on Overleaf" build instead of
      // the local preflight PDF (cached the same way: in memory, per boot).
      if (req.query.source === "remote") {
        const remotePath = lastRemoteCompile.get(project.id);
        if (!remotePath || !existsSync(remotePath)) {
          return reply.code(404).send({ error: "no Overleaf build — run Verify on Overleaf first" });
        }
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Disposition", `inline; filename="${safeName}-overleaf.pdf"`);
        return reply.type("application/pdf").send(createReadStream(remotePath));
      }
      const compile = getLastCompile(project.id);
      if (!compile?.pdfPath || !existsSync(compile.pdfPath)) {
        return reply.code(404).send({ error: "no compiled PDF — run compile first" });
      }
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Disposition", `inline; filename="${safeName}.pdf"`);
      return reply.type("application/pdf").send(createReadStream(compile.pdfPath));
    },
  );

  // Read-only reverse lookup: text copied from the rendered PDF → the .tex
  // source position that produced it (used by the viewer's double-click jump).
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/projects/:id/locate",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const text = (req.body?.text ?? "").slice(0, 4000);
      if (!text.trim()) return reply.code(400).send({ error: "text is required" });
      const dir = projectDir(project.id);
      const sources = listFiles(dir)
        .filter((f) => f.endsWith(".tex"))
        .map((file) => {
          try {
            return { file, content: readFileSync(join(dir, file), "utf8") };
          } catch {
            return { file, content: "" };
          }
        });
      const hit = locateInSources(text, sources);
      if (!hit) return reply.code(404).send({ error: "no match" });
      return { file: hit.file, line: hit.line };
    },
  );
}
