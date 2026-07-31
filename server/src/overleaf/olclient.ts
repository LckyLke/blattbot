/**
 * Cookie-authenticated client for the Overleaf web interface.
 * Works against overleaf.com, Community Edition, and Server Pro — the routes
 * are identical (verified against overleaf/overleaf web router source):
 *
 *   GET    /project/:id/download/zip           project source as zip
 *   GET    /project/:id/entities               [{path, type}] (no ids)
 *   POST   /project/:id/upload                 multipart qqfile + name + relativePath
 *   POST   /project/:id/folder                 {name, parent_folder_id}
 *   DELETE /project/:id/{doc|file|folder}/:entityId
 *   POST   /project/:id/compile                run the instance's own compiler
 *   socket.io 0.9 joinProject                  full file tree WITH entity ids
 *   socket.io 0.9 joinDoc/applyOtUpdate/leaveDoc  in-place text-doc edits
 */
import WebSocket from "ws";
import { type TextOpComponent } from "./ot.js";

export class OverleafAuthError extends Error {
  constructor(message = "Overleaf session rejected — the cookie has probably expired. Paste a fresh one.") {
    super(message);
    this.name = "OverleafAuthError";
  }
}

export interface OverleafRef {
  baseUrl: string;
  projectId: string;
}

/**
 * Canonical instance origin: follow the instance's own redirect once, so bare
 * "overleaf.com" becomes "https://www.overleaf.com". Vital because fetch
 * strips Cookie headers on cross-origin redirects — validating a session
 * against the non-canonical host always looks logged-out.
 */
export async function canonicalOrigin(url: string): Promise<string> {
  const raw = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const base = parseProjectUrl(withScheme)?.baseUrl ?? new URL(withScheme).origin;
  try {
    const res = await fetch(`${base}/login`, {
      redirect: "follow",
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    return new URL(res.url).origin;
  } catch {
    return base;
  }
}

/** Parse a pasted editor link like https://host/project/24hexchars into base + id. */
export function parseProjectUrl(url: string): OverleafRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const m = /\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/.exec(u.pathname + u.search);
  if (!m) return null;
  return { baseUrl: `${u.protocol}//${u.host}`, projectId: m[1] };
}

export interface OlProjectInfo {
  id: string;
  name: string;
  lastUpdated?: string;
  archived?: boolean;
  trashed?: boolean;
}

/** Decode the HTML-attribute escaping Overleaf applies to meta content. */
function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Extract an ol-* meta tag's decoded content. JSON metas carry extra
 * attributes between name and content (`data-type="json"`), so anything
 * up to the content attribute is tolerated.
 */
function metaContent(html: string, name: string): string | null {
  const m = new RegExp(`<meta\\s+name="${name}"[^>]*?content="([^"]*)"`).exec(html);
  return m ? decodeHtmlAttr(m[1]) : null;
}

export interface TreeEntity {
  path: string;
  type: "doc" | "file";
  id: string;
}

export interface ProjectTree {
  rootFolderId: string;
  /** path (no leading slash) → entity */
  entities: Map<string, TreeEntity>;
  /** folder path (no leading slash, "" = root) → folder id */
  folders: Map<string, string>;
}

export interface RemoteCompileResult {
  /** Overleaf's compile status, e.g. "success" or "failure". */
  status: string;
  /** The compiled output.pdf — present only on a successful build. */
  pdf?: Buffer;
  /** Tail of Overleaf's compile log when there is no PDF to show. */
  logTail?: string;
}

function looksLikeLoginRedirect(res: Response): boolean {
  if (res.status === 401 || res.status === 403) return true;
  const ct = res.headers.get("content-type") ?? "";
  return res.ok && ct.includes("text/html") && res.url.includes("/login");
}

export class OverleafClient {
  private csrfToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: this.cookie,
      Accept: "application/json, */*",
      // Some hosted instances vary behavior on non-browser agents.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ...extra,
    };
  }

  private async fetchChecked(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      redirect: "follow",
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(60_000),
    });
    if (looksLikeLoginRedirect(res)) throw new OverleafAuthError();
    return res;
  }

  /** Fetch and cache the CSRF token from the project dashboard's meta tag. */
  async csrf(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const res = await this.fetchChecked("/project", { headers: { Accept: "text/html" } });
    const html = await res.text();
    const m = metaContent(html, "ol-csrfToken");
    if (!m) throw new OverleafAuthError("Could not find a CSRF token — is the session cookie valid?");
    this.csrfToken = m;
    return this.csrfToken;
  }

  /**
   * All projects visible to this session, from the dashboard's prefetched
   * project list (meta tag `ol-prefetchedProjectsBlob`; older CE releases
   * used `ol-projects` with a bare array).
   */
  async listProjects(): Promise<OlProjectInfo[]> {
    const res = await this.fetchChecked("/project", { headers: { Accept: "text/html" } });
    const html = await res.text();
    const blob = metaContent(html, "ol-prefetchedProjectsBlob") ?? metaContent(html, "ol-projects");
    if (!blob) {
      throw new Error(
        "Could not read the project list from the Overleaf dashboard — is the session cookie valid?",
      );
    }
    const data = JSON.parse(blob);
    const raw: any[] = Array.isArray(data) ? data : (data?.projects ?? []);
    return raw
      .map((p) => ({
        id: String(p.id ?? p._id ?? ""),
        name: String(p.name ?? "Untitled"),
        lastUpdated: typeof p.lastUpdated === "string" ? p.lastUpdated : undefined,
        archived: Boolean(p.archived),
        trashed: Boolean(p.trashed),
      }))
      .filter((p) => /^[0-9a-fA-F]{24}$/.test(p.id));
  }

  /** Best-effort signed-in email from the dashboard meta tags. */
  async userEmail(): Promise<string | undefined> {
    try {
      const res = await this.fetchChecked("/project", { headers: { Accept: "text/html" } });
      const html = await res.text();
      const direct = metaContent(html, "ol-usersEmail");
      if (direct) return direct;
      const blob = metaContent(html, "ol-user");
      if (blob) {
        const user = JSON.parse(blob);
        if (typeof user?.email === "string") return user.email;
      }
    } catch {
      /* cosmetic only */
    }
    return undefined;
  }

  /** Best-effort project title from the dashboard's prefetched project list. */
  async projectName(projectId: string): Promise<string | undefined> {
    try {
      return (await this.listProjects()).find((p) => p.id === projectId)?.name;
    } catch {
      return undefined;
    }
  }

  async downloadZip(projectId: string): Promise<Buffer> {
    const res = await this.fetchChecked(`/project/${projectId}/download/zip`, {
      headers: { Accept: "application/zip, */*" },
    });
    if (!res.ok) throw new Error(`zip download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // A login page instead of a zip means the cookie died between checks.
    if (buf.length < 4 || buf.readUInt16BE(0) !== 0x504b) throw new OverleafAuthError();
    return buf;
  }

  async entities(projectId: string): Promise<{ path: string; type: "doc" | "file" }[]> {
    const res = await this.fetchChecked(`/project/${projectId}/entities`);
    if (!res.ok) throw new Error(`entities failed: HTTP ${res.status}`);
    const data: any = await res.json();
    return (data.entities ?? []).map((e: any) => ({
      path: String(e.path).replace(/^\//, ""),
      type: e.type === "doc" ? "doc" : "file",
    }));
  }

  /**
   * Join the project over Overleaf's socket.io 0.9 channel to obtain the full
   * file tree with entity ids. Handles both the classic explicit-join flow and
   * the newer auto-join (joinProjectResponse) flow.
   */
  async joinProjectTree(projectId: string): Promise<ProjectTree> {
    const session = await this.connectRealtime(projectId);
    try {
      return buildTree(session.project);
    } finally {
      session.close();
    }
  }

  /**
   * Open a realtime session already joined to the project, for in-place doc
   * edits (joinDoc/applyOtUpdate/leaveDoc). The caller owns the session and
   * must close() it.
   */
  async connectRealtime(projectId: string): Promise<OlRealtimeSession> {
    const hs = await this.fetchChecked(
      `/socket.io/1/?projectId=${projectId}&t=${Date.now()}`,
      { headers: { Accept: "*/*" } },
    );
    if (!hs.ok) throw new Error(`socket.io handshake failed: HTTP ${hs.status}`);
    const sid = (await hs.text()).split(":")[0];
    if (!sid) throw new Error("socket.io handshake returned no session id");

    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/socket.io/1/websocket/${sid}`;
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: this.cookie, Origin: this.baseUrl },
    });
    return OlRealtimeSession.open(ws, projectId);
  }

  /**
   * Upload a file. When folderId is given (required by older CE builds, which
   * 422 with "folder_not_found" without it) the file lands in that folder and
   * relativePath is not used; otherwise relativePath lets newer servers create
   * intermediate folders themselves.
   */
  async uploadFile(
    projectId: string,
    relPath: string,
    content: Buffer,
    folderId?: string,
  ): Promise<{ ok: boolean; duplicate: boolean }> {
    const token = await this.csrf();
    const name = relPath.split("/").pop()!;
    const dir = folderId ? null : relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : null;

    const boundary = `----blattbot${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const field = (fieldName: string, value: string) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`,
        ),
      );
    };
    // NB: plain fields must precede the file part for multer to see them.
    field("name", name);
    field("relativePath", dir ? `${dir}/${name}` : "null");
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="qqfile"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );

    const qs = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
    const res = await this.fetchChecked(`/project/${projectId}/upload${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-Csrf-Token": token,
      },
      body: Buffer.concat(parts),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data?.success) return { ok: true, duplicate: false };
    if (data?.error === "duplicate_file_name") return { ok: false, duplicate: true };
    throw new Error(`upload of ${relPath} failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }

  /**
   * Create a new project and return its id. Shape verified live against
   * Overleaf CE: POST /project/new with {projectName, template:"example"}
   * (CSRF header required) responds {project_id}.
   */
  async createProject(projectName: string): Promise<string> {
    const token = await this.csrf();
    const res = await this.fetchChecked("/project/new", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify({ projectName, template: "example" }),
    });
    const data: any = await res.json().catch(() => ({}));
    const id = data?.project_id;
    if (!res.ok || !id) {
      throw new Error(`create project failed: HTTP ${res.status} ${JSON.stringify(data)}`);
    }
    return String(id);
  }

  /** Create a folder and return its id. */
  async createFolder(projectId: string, name: string, parentFolderId: string): Promise<string> {
    const token = await this.csrf();
    const res = await this.fetchChecked(`/project/${projectId}/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId }),
    });
    const data: any = await res.json().catch(() => ({}));
    const id = data?._id ?? data?.folder?._id;
    if (!res.ok || !id) {
      throw new Error(`create folder ${name} failed: HTTP ${res.status} ${JSON.stringify(data)}`);
    }
    return String(id);
  }

  async deleteEntity(projectId: string, type: "doc" | "file" | "folder", entityId: string): Promise<void> {
    const token = await this.csrf();
    const res = await this.fetchChecked(`/project/${projectId}/${type}/${entityId}`, {
      method: "DELETE",
      headers: { "X-Csrf-Token": token },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`delete ${type} ${entityId} failed: HTTP ${res.status}`);
    }
  }

  /**
   * Run Overleaf's own compiler on the project's CURRENT REMOTE state.
   * A successful build yields the output.pdf bytes; anything else yields the
   * tail of the remote compile log instead (a failure is a result, not an
   * error — only unexpected response shapes throw).
   */
  async compileProject(projectId: string): Promise<RemoteCompileResult> {
    const token = await this.csrf();
    const res = await this.fetchChecked(`/project/${projectId}/compile?auto_compile=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify({
        check: "silent",
        draft: false,
        incrementalCompilesEnabled: false,
        stopOnFirstError: false,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.status !== "string") {
      throw new Error(`remote compile failed: HTTP ${res.status} ${JSON.stringify(data)}`);
    }
    const outputFiles: any[] = Array.isArray(data.outputFiles) ? data.outputFiles : [];
    // Output urls are server-relative, but overleaf.com omits the CLSI affinity
    // params from them — its web client appends clsiserverid (and compileGroup)
    // from the compile response, and without clsiserverid the load balancer
    // routes the download to the wrong compile server (HTTP 404). CE responses
    // carry no clsiServerId, so nothing is appended there.
    const withClsiParams = (url: string): string => {
      const extra: string[] = [];
      if (typeof data.clsiServerId === "string" && data.clsiServerId && !/[?&]clsiserverid=/.test(url)) {
        extra.push(`clsiserverid=${encodeURIComponent(data.clsiServerId)}`);
      }
      if (typeof data.compileGroup === "string" && data.compileGroup && !/[?&]compileGroup=/.test(url)) {
        extra.push(`compileGroup=${encodeURIComponent(data.compileGroup)}`);
      }
      if (extra.length === 0) return url;
      return url + (url.includes("?") ? "&" : "?") + extra.join("&");
    };
    const urlOf = (path: string): string | undefined => {
      const u = outputFiles.find((f) => f?.path === path)?.url;
      return typeof u === "string" ? withClsiParams(u) : undefined;
    };
    const pdfUrl = urlOf("output.pdf");
    if (data.status === "success" && pdfUrl) {
      const pdfRes = await this.fetchChecked(pdfUrl, { headers: { Accept: "application/pdf, */*" } });
      if (!pdfRes.ok) throw new Error(`compiled PDF download failed: HTTP ${pdfRes.status}`);
      const buf = Buffer.from(await pdfRes.arrayBuffer());
      // A login page instead of a PDF means the cookie died between checks.
      if (buf.length < 4 || buf.toString("latin1", 0, 4) !== "%PDF") throw new OverleafAuthError();
      return { status: data.status, pdf: buf };
    }
    // No PDF — surface the remote compiler's log so the user sees WHY.
    const logUrl = urlOf("output.log");
    let logTail: string | undefined;
    if (logUrl) {
      try {
        const logRes = await this.fetchChecked(logUrl, { headers: { Accept: "text/plain, */*" } });
        if (logRes.ok) logTail = (await logRes.text()).slice(-4000);
      } catch {
        /* best-effort — the status alone still tells the story */
      }
    }
    return { status: data.status, logTail };
  }
}

type SessionEventListener = (name: string, args: any[]) => void;

/**
 * Overleaf's realtime service transports doc lines UTF-8-encoded per line
 * (`unescape(encodeURIComponent(line))` server-side, applied unconditionally
 * in WebsocketController.joinDoc); the client restores the real text with
 * `decodeURIComponent(escape(line))`. Plain ASCII round-trips unchanged; a
 * line that fails to decode (raw bytes that are not valid UTF-8) is passed
 * through as-is.
 */
function decodeSocketLine(line: string): string {
  try {
    return decodeURIComponent(escape(line));
  } catch {
    return line;
  }
}

/**
 * One live socket.io 0.9 connection, joined to a project. Heartbeat frames
 * (`2::`) are echoed for the session's lifetime; events go out as
 * `5:<msgId>+::{"name",…}` frames and acks are correlated back by message id.
 * Acks follow the Overleaf node-callback convention: args[0] is the error
 * (null on success).
 */
export class OlRealtimeSession {
  /** Raw project object from the join — joinProjectTree builds the tree from it. */
  project: any = null;
  /**
   * First otUpdateError the server pushed. Real Overleaf acks applyOtUpdate
   * when the op is merely ENQUEUED; genuine apply failures arrive later as
   * this event (followed by a disconnect), so callers must check it when
   * verifying an edit actually landed.
   */
  otUpdateError: Error | null = null;
  private nextMsgId = 1;
  private dead: Error | null = null;
  private onConnected: (() => void) | null = null;
  private onDeath: ((err: Error) => void) | null = null;
  private readonly pending = new Map<number, { resolve: (args: any[]) => void; reject: (err: Error) => void }>();
  private readonly listeners = new Set<SessionEventListener>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("error", (err) => this.destroy(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => this.destroy(new Error("realtime connection closed")));
    ws.on("message", (raw) => this.onFrame(raw.toString()));
    this.listeners.add((name, args) => {
      if (name === "otUpdateError" && !this.otUpdateError) {
        this.otUpdateError = new Error(`otUpdateError: ${JSON.stringify(args?.[0] ?? "unknown")}`);
      }
    });
  }

  /**
   * Connect and join the project. Handles both the classic explicit-join flow
   * and the newer auto-join (joinProjectResponse) flow; the websocket is
   * closed again if the join fails.
   */
  static async open(ws: WebSocket, projectId: string): Promise<OlRealtimeSession> {
    const session = new OlRealtimeSession(ws);
    try {
      session.project = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timed out waiting for project tree over websocket"));
        }, 15_000);
        const done = (p: any) => {
          clearTimeout(timer);
          resolve(p);
        };
        const fail = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };
        session.onDeath = fail;
        session.listeners.add((name, args) => {
          if (name === "joinProjectResponse" && args?.[0]?.project) done(args[0].project);
          // Modern real-time never acks a failed auto-join — it emits
          // connectionRejected with the reason and disconnects. Fail fast
          // with that reason instead of hanging into the timeout.
          if (name === "connectionRejected") {
            const reason = args?.[0]?.message ?? JSON.stringify(args?.[0] ?? "unknown");
            fail(new Error(`Overleaf rejected the connection: ${reason}`));
          }
        });
        session.onConnected = () => {
          // connected — request the join explicitly (classic flow; newer
          // servers auto-join from the handshake's projectId and ignore this,
          // so its ack may never come — the overall timer decides then)
          session.emit("joinProject", [{ project_id: projectId }], 20_000).then((args) => {
            if (args?.[1]) done(args[1]);
          }, fail);
        };
      });
    } catch (err) {
      session.close();
      throw err;
    }
    session.onDeath = null;
    return session;
  }

  /** Send an event and await its ack; rejects on error ack, loss, or timeout. */
  emit(name: string, args: unknown[], timeoutMs = 10_000): Promise<any[]> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextMsgId++;
    return new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name}: no ack within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (ackArgs) => {
          clearTimeout(timer);
          if (ackArgs?.[0]) reject(new Error(`${name} error: ${JSON.stringify(ackArgs[0])}`));
          else resolve(ackArgs);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(`5:${id}+::${JSON.stringify({ name, args })}`);
    });
  }

  /** Join a doc for editing; returns its current (decoded) text lines and OT version. */
  async joinDoc(docId: string): Promise<{ lines: string[]; version: number }> {
    const args = await this.emit("joinDoc", [docId, { encodeRanges: true }]);
    const lines = args?.[1];
    const version = args?.[2];
    if (!Array.isArray(lines) || typeof version !== "number") {
      throw new Error(`joinDoc ${docId}: unexpected ack ${JSON.stringify(args)}`);
    }
    return { lines: lines.map((l) => decodeSocketLine(String(l))), version };
  }

  /**
   * Apply a sharejs text op at the given doc version. Overleaf reports
   * failures either as an error ack or as a separate otUpdateError event —
   * either one within the wait window rejects. NB: on real servers a success
   * ack only means the op was ENQUEUED (document-updater applies it
   * asynchronously) — callers must verify via a fresh joinDoc and the
   * session's otUpdateError field.
   */
  async applyOtUpdate(docId: string, op: TextOpComponent[], version: number): Promise<void> {
    let onEvent: SessionEventListener = () => {};
    const otError = new Promise<never>((_, reject) => {
      onEvent = (name, args) => {
        if (name === "otUpdateError") {
          reject(new Error(`applyOtUpdate error: ${JSON.stringify(args?.[0] ?? "otUpdateError")}`));
        }
      };
    });
    this.listeners.add(onEvent);
    try {
      // race() attaches handlers to both, so neither rejection goes unhandled.
      await Promise.race([this.emit("applyOtUpdate", [docId, { doc: docId, op, v: version }]), otError]);
    } finally {
      this.listeners.delete(onEvent);
    }
  }

  async leaveDoc(docId: string): Promise<void> {
    await this.emit("leaveDoc", [docId]);
  }

  /** Whether the connection is still usable. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** Close the connection; in-flight emits are rejected. */
  close(): void {
    this.destroy(new Error("realtime session closed"));
    this.ws.close();
  }

  private destroy(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const waiter of [...this.pending.values()]) waiter.reject(err);
    this.pending.clear();
    this.onDeath?.(err);
  }

  private onFrame(frame: string): void {
    const sep1 = frame.indexOf(":");
    const type = frame.slice(0, sep1 === -1 ? undefined : sep1);
    if (type === "2") {
      this.ws.send("2::"); // heartbeat — echo it or the server drops us
      return;
    }
    if (type === "1") {
      this.onConnected?.();
      this.onConnected = null;
      return;
    }
    if (type === "5") {
      // event frame: 5:::{json}
      const body = frame.slice(frame.indexOf(":::") + 3);
      try {
        const ev = JSON.parse(body);
        for (const listener of [...this.listeners]) {
          listener(String(ev?.name), Array.isArray(ev?.args) ? ev.args : []);
        }
      } catch {
        /* not json — ignore */
      }
      return;
    }
    if (type === "6") {
      // ack frame: `6:::<msgId>+[err, ...results]`, or bare `6:::<msgId>` for
      // a zero-argument callback() — socket.io 0.9 omits the '+JSON' part
      // entirely then. Real Overleaf acks applyOtUpdate success exactly that
      // way, so the argless form MUST resolve (as success with no payload).
      const m = /^6:::(\d+)(?:\+(.*))?$/s.exec(frame);
      if (!m) return;
      const waiter = this.pending.get(Number(m[1]));
      if (!waiter) return;
      this.pending.delete(Number(m[1]));
      if (m[2] === undefined) {
        waiter.resolve([]);
        return;
      }
      try {
        waiter.resolve(JSON.parse(m[2]));
      } catch {
        /* unparseable ack — the emit's timeout surfaces it */
      }
    }
  }
}

function buildTree(project: any): ProjectTree {
  const root = project?.rootFolder?.[0];
  if (!root?._id) throw new Error("project tree missing rootFolder");
  const tree: ProjectTree = {
    rootFolderId: String(root._id),
    entities: new Map(),
    folders: new Map([["", String(root._id)]]),
  };
  const walk = (folder: any, prefix: string) => {
    for (const doc of folder.docs ?? []) {
      tree.entities.set(prefix + doc.name, { path: prefix + doc.name, type: "doc", id: String(doc._id) });
    }
    for (const file of folder.fileRefs ?? []) {
      tree.entities.set(prefix + file.name, { path: prefix + file.name, type: "file", id: String(file._id) });
    }
    for (const sub of folder.folders ?? []) {
      const subPath = prefix + sub.name;
      tree.folders.set(subPath, String(sub._id));
      walk(sub, subPath + "/");
    }
  };
  walk(root, "");
  return tree;
}
