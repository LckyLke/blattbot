// Working-tree file read/save, the .bib and label indexes, and @-mention
// file search.
import type { FastifyInstance } from "fastify";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { mentionFiles } from "../file-mentions.js";
import { getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import { scanLabels } from "../latex.js";
import { readAllBibEntries } from "../citations.js";
import { isTurnActive } from "../agent.js";
import { withProjectLock } from "../project-lock.js";

const MAX_TEXT_FILE = 2 * 1024 * 1024;

export function registerFileRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/file",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const rel = (req.query.path ?? "").trim();
      if (!rel) return reply.code(400).send({ error: "path is required" });
      const dir = projectDir(project.id);
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }
      let size: number;
      try {
        const st = statSync(abs);
        if (!st.isFile()) return reply.code(400).send({ error: "not a file" });
        size = st.size;
      } catch {
        return reply.code(404).send({ error: "no such file" });
      }
      if (size > MAX_TEXT_FILE) return { path: rel, size, binary: true, content: "" };
      const buf = readFileSync(abs);
      const binary = buf.includes(0);
      return { path: rel, size, binary, content: binary ? "" : buf.toString("utf8") };
    },
  );

  app.put<{ Params: { id: string }; Body: { path?: string; content?: string; base?: string } }>(
    "/api/projects/:id/file",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const rel = (req.body?.path ?? "").trim();
      const content = req.body?.content;
      if (!rel || typeof content !== "string") {
        return reply.code(400).send({ error: "path and content are required" });
      }
      if (Buffer.byteLength(content) > MAX_TEXT_FILE) {
        return reply.code(413).send({ error: "file too large" });
      }
      const dir = projectDir(project.id);
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }
      // Manual edits touch existing files only — new files come from the agent or sync.
      try {
        if (!statSync(abs).isFile()) return reply.code(400).send({ error: "not a file" });
      } catch {
        return reply.code(404).send({ error: "no such file" });
      }
      const base = req.body.base;
      const diff = await withProjectLock(project.id, async () => {
        if (base !== undefined && (typeof base !== "string" || readFileSync(abs, "utf8") !== base)) return null;
        writeFileSync(abs, content);
        return git.workingDiff(dir).catch(() => "");
      });
      if (diff === null) {
        return reply.code(409).send({ error: "This file changed since you opened the passage. Your draft is preserved; open it in Source to reconcile the changes." });
      }
      return { ok: true, diff };
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/bib", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const entries = readAllBibEntries(projectDir(project.id)).map(({ file, entry }) => ({
      file,
      key: entry.key,
      type: entry.type,
      title: entry.fields.title ?? null,
      author: entry.fields.author ?? null,
      year: entry.fields.year ?? null,
      doi: entry.fields.doi ?? null,
    }));
    return { entries };
  });

  // Read-only \label{} index across the project's .tex files — feeds the source
  // editor's \ref/\cref autocomplete.
  app.get<{ Params: { id: string } }>("/api/projects/:id/labels", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return { labels: scanLabels(projectDir(project.id)) };
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/projects/:id/mention-files", async (req, reply) => {
    if (!getProject(req.params.id)) return reply.code(404).send({ error: "unknown project" });
    return mentionFiles(req.params.id, String(req.query.q ?? "").slice(0, 200));
  });
}
