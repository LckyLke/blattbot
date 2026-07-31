/**
 * In-memory mock of an Overleaf CE instance, faithful to the endpoints
 * BlattBot's cookie-sync uses (shapes verified against overleaf/overleaf):
 *   GET  /project                          dashboard HTML (csrf meta + prefetched projects)
 *   POST /project/new                      {projectName, template} → {project_id}
 *   GET  /project/:id/download/zip
 *   GET  /project/:id/entities
 *   POST /project/:id/upload               multipart qqfile; rejects duplicates
 *   DELETE /project/:id/{doc|file|folder}/:entityId
 *   POST /project/:id/compile              {status, outputFiles} + served outputs
 *   socket.io 0.9 handshake + joinProject  file tree with entity ids
 *   socket.io 0.9 joinDoc/applyOtUpdate/leaveDoc  per-doc OT versions, in-place edits
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
  /** path → OT version (0 until the first applyOtUpdate lands). */
  docVersions: Map<string, number>;
}

export interface MockOverleaf {
  port: number;
  /** The primary project's id (files/uploads/deletes below alias its state). */
  projectId: string;
  files: Map<string, Buffer>;
  uploads: { path: string; size: number }[];
  deletes: string[];
  /** The primary project's per-doc OT versions (path → version). */
  docVersions: Map<string, number>;
  /** Projects created via POST /project/new, in creation order. */
  created: MockProject[];
  authOk: boolean;
  /** Test hook: when set, applyOtUpdate replies with this error message. */
  failOtUpdate: string | null;
  /** Test hook: when set, applyOtUpdate ACKS success (argless, like real CE's
   *  enqueue ack) but never applies the op — an otUpdateError event with this
   *  message follows asynchronously, then the socket closes (like real CE). */
  asyncFailOtUpdate: string | null;
  /** Test hook: when set, realtime connections are rejected right after the
   *  handshake via a connectionRejected event with this message (what real
   *  servers do for revoked access), then the socket closes. */
  rejectRealtime: string | null;
  /** Test hook: when true, POST /project/:id/compile reports a failed build
   *  (status "failure" with only an output.log to fetch). */
  failCompile: boolean;
  /** Test hook: bump the doc's version right before the next applyOtUpdate
   *  (simulates a collaborator op racing ours — forces a version conflict). */
  conflictNextOtUpdate: boolean;
  /** Total websocket connections accepted (tree joins + realtime sessions). */
  wsConnections: number;
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

/** LaTeX-flavoured compile log the mock serves as output.log. */
const COMPILE_LOG = `This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)
entering extended mode
(./main.tex
LaTeX2e <2024-06-01>
! Undefined control sequence.
l.3 \\badmacro
The control sequence at the end of the top line of your error message was
never \\def'ed.
No pages of output.
`;

/** A minimal but structurally valid single-page PDF (real xref offsets). */
function minimalPdf(): Buffer {
  const objects = [
    "1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    "2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xref = body.length;
  body += "xref\n0 4\n0000000000 65535 f \n";
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const MOCK_PDF = minimalPdf();

export async function startMockOverleaf(
  port: number,
  projectId: string,
  projectName = "Mock Thesis",
  /** Additional dashboard-listed projects (template files, importable). */
  extraProjects: { id: string; name: string }[] = [],
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
    docVersions: new Map(),
  });

  const primary = newProject(projectId, projectName, "rootfolder0");
  const projects = new Map<string, MockProject>([[projectId, primary]]);
  for (const [i, extra] of extraProjects.entries()) {
    const p = newProject(extra.id, extra.name, `rootfolder-x${i}`);
    p.files.set("main.tex", Buffer.from(TEMPLATE_MAIN));
    p.files.set("sample.bib", Buffer.from(TEMPLATE_BIB));
    projects.set(extra.id, p);
  }

  const state: MockOverleaf = {
    port,
    projectId,
    files: primary.files,
    uploads: primary.uploads,
    deletes: primary.deletes,
    docVersions: primary.docVersions,
    created: [],
    authOk: true,
    failOtUpdate: null,
    asyncFailOtUpdate: null,
    rejectRealtime: null,
    failCompile: false,
    conflictNextOtUpdate: false,
    wsConnections: 0,
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
  /** Real real-time escapes EVERY joinDoc line for the socket (WebsocketController's
   *  encodeForWebsockets): UTF-8 bytes spread out as single chars. Clients decode
   *  with decodeURIComponent(escape(line)). Ops arrive as real text — no decoding. */
  const encodeForWebsockets = (line: string) => unescape(encodeURIComponent(line));
  /** Reverse-lookup a doc entity id across all projects (folders excluded). */
  const docByEntityId = (docId: string): { proj: MockProject; path: string } | undefined => {
    for (const p of projects.values()) {
      const hit = [...p.entityIds.entries()].find(([path, id]) => id === docId && !path.startsWith("__folder__/"));
      if (hit) return { proj: p, path: hit[0] };
    }
    return undefined;
  };

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

    // Run the "remote compiler": success lists an output.pdf to fetch, a
    // forced failure (state.failCompile) only the log — like a real failed build.
    if (proj && req.method === "POST" && sub === "/compile") {
      if (!csrfOk()) {
        respond(403, JSON.stringify({ message: "invalid csrf token" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer); // options ignored
      const out = (path: string, type: string) => ({
        path,
        url: `/project/${proj.id}/output/${path}?compileGroup=standard&build=mockbuild123&clsiserverid=mock-clsi`,
        build: "mockbuild123",
        type,
      });
      respond(
        200,
        JSON.stringify(
          state.failCompile
            ? { status: "failure", outputFiles: [out("output.log", "log")] }
            : {
                status: "success",
                outputFiles: [out("output.pdf", "pdf"), out("output.log", "log")],
                clsiServerId: "mock-clsi",
              },
        ),
      );
      return;
    }

    // Compile outputs, at the urls the compile response handed out.
    if (proj && req.method === "GET" && sub.startsWith("/output/")) {
      const file = sub.slice("/output/".length);
      if (file === "output.pdf" && !state.failCompile) {
        respond(200, MOCK_PDF, "application/pdf");
        return;
      }
      if (file === "output.log") {
        respond(200, COMPILE_LOG, "text/plain");
        return;
      }
      respond(404, JSON.stringify({ error: "not found", path: url.pathname }));
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
      state.wsConnections++;
      ws.send("1::");
      if (state.rejectRealtime) {
        // Like real real-time on a failed auto-join: no joinProject ack ever —
        // just connectionRejected with the reason, then a disconnect.
        ws.send(`5:::${JSON.stringify({ name: "connectionRejected", args: [{ message: state.rejectRealtime }] })}`);
        setTimeout(() => ws.close(), 20);
        return;
      }
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
          return;
        }
        const err = (message: string) => ws.send(`6:::${msgId}+${JSON.stringify([{ message }])}`);
        if (ev.name === "joinDoc") {
          const hit = docByEntityId(String(ev.args?.[0] ?? ""));
          if (!hit) {
            err("doc not found");
            return;
          }
          const lines = (hit.proj.files.get(hit.path) ?? Buffer.alloc(0))
            .toString("utf8")
            .split("\n")
            .map(encodeForWebsockets);
          const version = hit.proj.docVersions.get(hit.path) ?? 0;
          ws.send(`6:::${msgId}+${JSON.stringify([null, lines, version, []])}`);
          return;
        }
        if (ev.name === "applyOtUpdate") {
          const hit = docByEntityId(String(ev.args?.[0] ?? ""));
          if (!hit) {
            err("doc not found");
            return;
          }
          if (state.failOtUpdate) {
            err(state.failOtUpdate);
            return;
          }
          if (state.asyncFailOtUpdate) {
            // Real CE acks the ENQUEUE, then document-updater rejects the op
            // asynchronously: otUpdateError is pushed and the socket dropped.
            const message = state.asyncFailOtUpdate;
            ws.send(`6:::${msgId}`);
            setTimeout(() => {
              ws.send(`5:::${JSON.stringify({ name: "otUpdateError", args: [{ message }] })}`);
              ws.close();
            }, 20);
            return;
          }
          const { proj, path } = hit;
          if (state.conflictNextOtUpdate) {
            // One-shot: a collaborator op "lands" first, invalidating the client's version.
            state.conflictNextOtUpdate = false;
            proj.docVersions.set(path, (proj.docVersions.get(path) ?? 0) + 1);
          }
          const update = ev.args?.[1] ?? {};
          const version = proj.docVersions.get(path) ?? 0;
          if (update.v !== version) {
            err("Op at wrong version");
            return;
          }
          let text = (proj.files.get(path) ?? Buffer.alloc(0)).toString("utf8");
          for (const comp of Array.isArray(update.op) ? update.op : []) {
            if (typeof comp?.d === "string") {
              if (text.slice(comp.p, comp.p + comp.d.length) !== comp.d) {
                err("Delete component does not match");
                return;
              }
              text = text.slice(0, comp.p) + text.slice(comp.p + comp.d.length);
            } else if (typeof comp?.i === "string") {
              text = text.slice(0, comp.p) + comp.i + text.slice(comp.p);
            }
          }
          proj.files.set(path, Buffer.from(text));
          proj.docVersions.set(path, version + 1);
          // Real Overleaf acks applyOtUpdate success with callback() — ZERO
          // args, which socket.io 0.9 serializes as a bare `6:::<id>` frame.
          ws.send(`6:::${msgId}`);
          return;
        }
        if (ev.name === "leaveDoc") {
          ws.send(`6:::${msgId}+${JSON.stringify([null])}`);
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
