// External read-only context (linked folders, uploads) and chat image uploads.
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { getProject, updateProject } from "../config.js";
import {
  browseDirectories,
  deleteUpload,
  listContext,
  saveUpload,
  uploadPath,
  validateLinkPath,
} from "../context.js";
import { findChatImage, saveChatImage } from "../chatimages.js";

export function registerContextRoutes(app: FastifyInstance): void {
  // ---- External read-only context (code, data, literature) -------------------

  // Folder picker for the link form: subdirectories only, credential stores and
  // BlattBot's own data excluded (see browseDirectories). Not project-scoped —
  // it browses the machine, so it sits behind the same local-token auth as
  // everything else under /api.
  app.get<{ Querystring: { path?: string } }>("/api/fs/dirs", async (req, reply) => {
    try {
      return browseDirectories(req.query.path);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/context", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return listContext(project);
  });

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    "/api/projects/:id/context/link",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const raw = (req.body?.path ?? "").trim();
      if (!raw) return reply.code(400).send({ error: "path is required" });
      let path: string;
      try {
        path = validateLinkPath(project, raw);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      const links = project.contextPaths ?? [];
      if (!links.includes(path)) updateProject(project.id, { contextPaths: [...links, path] });
      return listContext(getProject(project.id)!);
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/context/link",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const path = (req.query.path ?? "").trim();
      updateProject(project.id, {
        contextPaths: (project.contextPaths ?? []).filter((p) => p !== path),
      });
      return listContext(getProject(project.id)!);
    },
  );

  app.post<{ Params: { id: string }; Body: { name?: string; text?: string; contentBase64?: string } }>(
    "/api/projects/:id/context/upload",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const { name, text, contentBase64 } = req.body ?? {};
      if (!name?.trim() || (text == null && !contentBase64)) {
        return reply.code(400).send({ error: "name and text or contentBase64 are required" });
      }
      try {
        const content = text != null ? Buffer.from(text, "utf8") : Buffer.from(contentBase64!, "base64");
        saveUpload(project.id, name, content);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      return listContext(getProject(project.id)!);
    },
  );

  app.delete<{ Params: { id: string; name: string } }>(
    "/api/projects/:id/context/upload/:name",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      try {
        deleteUpload(project.id, req.params.name);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      return listContext(getProject(project.id)!);
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    "/api/projects/:id/context/upload/:name",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      let path: string;
      try {
        path = uploadPath(project.id, req.params.name);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
      if (!existsSync(path)) return reply.code(404).send({ error: "no such context file" });
      const lower = path.toLowerCase();
      const type = lower.endsWith(".pdf")
        ? "application/pdf"
        : /\.(txt|md|tex|bib|csv|json|py|ts|js|r)$/.test(lower)
          ? "text/plain; charset=utf-8"
          : "application/octet-stream";
      reply.header("Content-Disposition", "inline");
      return reply.type(type).send(createReadStream(path));
    },
  );

  // ---- Chat image attachments -------------------------------------------------
  // Uploads land in DATA_DIR/chat-uploads/<projectId>, NEVER the working tree:
  // a file there would show up in the review diff and be pushed to Overleaf.
  // Body is the raw image bytes (any of the accepted types, or
  // application/octet-stream) or JSON {contentBase64}. Both are sniffed.

  app.post<{ Params: { id: string }; Body: Buffer | { contentBase64?: string } }>(
    "/api/projects/:id/chat-image",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      let content: Buffer;
      if (Buffer.isBuffer(req.body)) {
        content = req.body;
      } else if (typeof (req.body as { contentBase64?: string })?.contentBase64 === "string") {
        content = Buffer.from((req.body as { contentBase64: string }).contentBase64, "base64");
      } else {
        return reply.code(400).send({ error: "the request body must be the image bytes or {contentBase64}" });
      }
      try {
        return saveChatImage(project.id, content);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  app.get<{ Params: { id: string; imageId: string } }>(
    "/api/projects/:id/chat-image/:imageId",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      // findChatImage matches the id against the server-generated UUID shape
      // before touching the filesystem — traversal never reaches a path join.
      const found = findChatImage(project.id, req.params.imageId);
      if (!found) return reply.code(404).send({ error: "no such chat image" });
      reply.header("Content-Disposition", "inline");
      // Ids are unique per upload, so the bytes behind one never change.
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      // Read into a buffer rather than streaming: these files are capped at a
      // few MB, and on Windows a stream's handle can outlive the response long
      // enough to make deleting the project's uploads fail with EPERM.
      return reply.type(found.mime).send(readFileSync(found.path));
    },
  );
}
