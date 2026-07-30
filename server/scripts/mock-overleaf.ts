/**
 * In-memory mock of an Overleaf CE instance, faithful to the endpoints
 * BlattBot's cookie-sync uses (shapes verified against overleaf/overleaf):
 *   GET  /project                          dashboard HTML (csrf meta + prefetched projects)
 *   POST /project/new                      {projectName, template} → {project_id}
 *   GET  /project/:id/download/zip
 *   GET  /project/:id/entities
 *   POST /project/:id/upload               multipart qqfile; rejects duplicates
 *   DELETE /project/:id/{doc|file|folder}/:entityId
 *   socket.io 0.9 handshake + joinProject  file tree with entity ids
 *
 * Supports multiple projects: the primary one passed to startMockOverleaf
 * (exposed via the legacy top-level files/uploads/deletes fields) plus any
 * created through POST /project/new (exposed via `created`).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { zipSync } from "fflate";

export interface MockProject {
  id: string;
  name: string;
  rootFolderId: string;
  files: Map<string, Buffer>;
  uploads: { path: string; size: number }[];
  deletes: string[];
  /** path (or "__folder__/<path>") → entity id */
  entityIds: Map<string, string>;
}

export interface MockOverleaf {
  port: number;
  /** The primary project's id (files/uploads/deletes below alias its state). */
  projectId: string;
  files: Map<string, Buffer>;
  uploads: { path: string; size: number }[];
  deletes: string[];
  /** Projects created via POST /project/new, in creation order. */
  created: MockProject[];
  authOk: boolean;
  close: () => Promise<void>;
}

const COOKIE = "overleaf_session2=mock-session";

const TEMPLATE_MAIN = `\\documentclass{article}
\\title{New template project}
\\begin{document}
\\maketitle
\\section{Introduction}
Template body.
\\bibliography{sample}
\\end{document}
`;

const TEMPLATE_BIB = `@article{template2020,
  title  = {A Template Reference},
  author = {Example, Eve},
  year   = {2020},
}
`;

export async function startMockOverleaf(
  port: number,
  projectId: string,
  projectName = "Mock Thesis",
): Promise<MockOverleaf> {
  let idCounter = 0;
  let projectCounter = 0;

  const newProject = (id: string, name: string, rootFolderId: string): MockProject => ({
    id,
    name,
    rootFolderId,
    files: new Map(),
    uploads: [],
    deletes: [],
    entityIds: new Map(),
  });

  const primary = newProject(projectId, projectName, "rootfolder0");
  const projects = new Map<string, MockProject>([[projectId, primary]]);

  const state: MockOverleaf = {
    port,
    projectId,
    files: primary.files,
    uploads: primary.uploads,
    deletes: primary.deletes,
    created: [],
    authOk: true,
    close: async () => {},
  };

  const idFor = (proj: MockProject, path: string) => {
    if (!proj.entityIds.has(path)) {
      proj.entityIds.set(path, `ent${(idCounter++).toString().padStart(4, "0")}`);
    }
    return proj.entityIds.get(path)!;
  };
  /** Folder id → path ("" = root); undefined = unknown id (upload must 422 then). */
  const folderPathFor = (proj: MockProject, id: string | null): string | undefined => {
    if (id === proj.rootFolderId) return "";
    if (!id) return undefined;
    const hit = [...proj.entityIds.entries()].find(([p, i]) => i === id && p.startsWith("__folder__/"));
    return hit?.[0].slice("__folder__/".length);
  };
  const isDoc = (path: string) => /\.(tex|bib|md|txt|cls|sty)$/.test(path);

  const authorized = (req: IncomingMessage) =>
    state.authOk && (req.headers.cookie ?? "").includes(COOKIE);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const respond = (code: number, body: string | Buffer, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    const csrfOk = () => req.headers["x-csrf-token"] === "mock-csrf-token";

    if (url.pathname === "/login") {
      // Simulate an instant successful login: set the session cookie and
      // bounce to the dashboard (real instances do this after the form/SSO).
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": `${COOKIE}; Path=/`,
      });
      res.end('<html><head><meta http-equiv="refresh" content="0;url=/project"></head><body>logging in…</body></html>');
      return;
    }

    if (!authorized(req)) {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/login` });
      res.end("Found. Redirecting to /login");
      return;
    }

    if (req.method === "GET" && url.pathname === "/project") {
      const blob = JSON.stringify({
        projects: [...projects.values()].map((p) => ({ id: p.id, name: p.name })),
      })
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;");
      respond(
        200,
        // NB: JSON metas carry data-type="json" between name and content on real instances.
        `<html><head><meta name="ol-csrfToken" content="mock-csrf-token"><meta name="ol-usersEmail" content="mock@example.org"><meta name="ol-prefetchedProjectsBlob" data-type="json" content="${blob}"></head><body></body></html>`,
        "text/html",
      );
      return;
    }

    // Create a project from a template — responds {project_id} like real CE.
    if (req.method === "POST" && url.pathname === "/project/new") {
      if (!csrfOk()) {
        respond(403, JSON.stringify({ message: "invalid csrf token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let parsed: any = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        /* empty */
      }
      if (!parsed.projectName || typeof parsed.projectName !== "string") {
        respond(400, JSON.stringify({ error: "projectName is required" }));
        return;
      }
      const n = projectCounter++;
      const id = `f${n.toString(16).padStart(23, "0")}`; // 24 hex chars
      const proj = newProject(id, parsed.projectName, `rootfolder-new${n}`);
      proj.files.set("main.tex", Buffer.from(TEMPLATE_MAIN));
      proj.files.set("sample.bib", Buffer.from(TEMPLATE_BIB));
      projects.set(id, proj);
      state.created.push(proj);
      respond(200, JSON.stringify({ project_id: id }));
      return;
    }

    // ---- per-project routes ----
    const projMatch = /^\/project\/([0-9a-fA-F]{24})(\/.*)?$/.exec(url.pathname);
    const proj = projMatch ? projects.get(projMatch[1]) : undefined;
    const sub = projMatch?.[2] ?? "";

    if (projMatch && !proj) {
      respond(404, JSON.stringify({ error: "project not found" }));
      return;
    }

    if (proj && req.method === "GET" && sub === "/download/zip") {
      const entries: Record<string, Uint8Array> = {};
      for (const [p, buf] of proj.files) entries[p] = new Uint8Array(buf);
      respond(200, Buffer.from(zipSync(entries)), "application/zip");
      return;
    }

    if (proj && req.method === "GET" && sub === "/entities") {
      respond(
        200,
        JSON.stringify({
          project_id: proj.id,
          entities: [...proj.files.keys()].sort().map((p) => ({ path: `/${p}`, type: isDoc(p) ? "doc" : "file" })),
        }),
      );
      return;
    }

    if (proj && req.method === "POST" && sub === "/folder") {
      if (!csrfOk()) {
        respond(403, JSON.stringify({ message: "invalid csrf token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let parsed: any = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        /* empty */
      }
      const parentPath = folderPathFor(proj, parsed.parent_folder_id);
      if (parsed.parent_folder_id !== proj.rootFolderId && parentPath === undefined) {
        respond(422, JSON.stringify({ success: false, error: "folder_not_found" }));
        return;
      }
      const path = parentPath ? `${parentPath}/${parsed.name}` : String(parsed.name ?? "unnamed");
      respond(200, JSON.stringify({ _id: idFor(proj, `__folder__/${path}`), name: parsed.name }));
      return;
    }

    if (proj && req.method === "POST" && sub === "/upload") {
      if (!csrfOk()) {
        respond(403, JSON.stringify({ message: "invalid csrf token" }));
        return;
      }
      // Like older CE builds (e.g. Paderborn): uploads REQUIRE a valid folder_id.
      const folderId = url.searchParams.get("folder_id");
      const folderPath = folderPathFor(proj, folderId);
      if (folderPath === undefined) {
        respond(422, JSON.stringify({ success: false, error: "folder_not_found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"] ?? ""))?.[1];
      if (!boundary) {
        respond(400, JSON.stringify({ success: false }));
        return;
      }
      const fields = parseMultipart(body, boundary);
      const name = fields.get("name")?.toString() ?? "unnamed";
      const content = fields.get("qqfile") ?? Buffer.alloc(0);
      const path = folderPath ? `${folderPath}/${name}` : name;

      if (proj.files.has(path)) {
        respond(422, JSON.stringify({ success: false, error: "duplicate_file_name" }));
        return;
      }
      proj.files.set(path, Buffer.from(content));
      proj.uploads.push({ path, size: content.length });
      respond(200, JSON.stringify({ success: true, entity_id: idFor(proj, path), entity_type: isDoc(path) ? "doc" : "file" }));
      return;
    }

    const del = proj && /^\/(doc|file|folder)\/(\w+)$/.exec(sub);
    if (proj && req.method === "DELETE" && del) {
      if (!csrfOk()) {
        respond(403, JSON.stringify({ message: "invalid csrf token" }));
        return;
      }
      const entityId = del[2];
      const path = [...proj.entityIds.entries()].find(([, id]) => id === entityId)?.[0];
      if (path) {
        proj.files.delete(path);
        proj.entityIds.delete(path);
        proj.deletes.push(path);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // socket.io 0.9 handshake
    if (req.method === "GET" && url.pathname === "/socket.io/1/") {
      respond(200, "mocksid123:60:60:websocket", "text/plain");
      return;
    }

    respond(404, JSON.stringify({ error: "not found", path: url.pathname }));
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/socket.io/1/websocket/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send("1::");
      ws.on("message", (raw) => {
        const frame = raw.toString();
        if (frame.startsWith("2::")) return; // heartbeat echo
        const m = /^5:(\d+)\+::(.*)$/s.exec(frame);
        if (!m) return;
        const msgId = m[1];
        const ev = JSON.parse(m[2]);
        if (ev.name === "joinProject") {
          const joinId = String(ev.args?.[0]?.project_id ?? projectId);
          const proj = projects.get(joinId);
          if (!proj) {
            ws.send(`6:::${msgId}+${JSON.stringify([{ message: "not authorized" }])}`);
            return;
          }
          // Build the folder tree from flat paths.
          type Folder = { _id: string; name: string; docs: any[]; fileRefs: any[]; folders: Folder[] };
          const root: Folder = { _id: proj.rootFolderId, name: "rootFolder", docs: [], fileRefs: [], folders: [] };
          const folderFor = (segments: string[]): Folder => {
            let cur = root;
            let path = "";
            for (const seg of segments) {
              path = path ? `${path}/${seg}` : seg;
              let next = cur.folders.find((f) => f.name === seg);
              if (!next) {
                next = { _id: idFor(proj, `__folder__/${path}`), name: seg, docs: [], fileRefs: [], folders: [] };
                cur.folders.push(next);
              }
              cur = next;
            }
            return cur;
          };
          for (const p of [...proj.files.keys()].sort()) {
            const segs = p.split("/");
            const name = segs.pop()!;
            const folder = folderFor(segs);
            const entry = { _id: idFor(proj, p), name };
            if (isDoc(p)) folder.docs.push(entry);
            else folder.fileRefs.push(entry);
          }
          const project = { _id: proj.id, name: proj.name, rootFolder: [root] };
          ws.send(`6:::${msgId}+${JSON.stringify([null, project, "owner", 2])}`);
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  state.close = () =>
    new Promise<void>((resolve) => {
      wss.close();
      server.close(() => resolve());
    });
  return state;
}

function parseMultipart(body: Buffer, boundary: string): Map<string, Buffer> {
  const fields = new Map<string, Buffer>();
  const parts = body.toString("binary").split(`--${boundary}`);
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    let value = part.slice(headerEnd + 4);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    if (value.endsWith("--")) value = value.slice(0, -2);
    fields.set(nameMatch[1], Buffer.from(value, "binary"));
  }
  return fields;
}
