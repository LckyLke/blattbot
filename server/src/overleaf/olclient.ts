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
import { normalizeSpans, withoutSpans, type ContentSpan, type TextOpComponent } from "./ot.js";

export class OverleafAuthError extends Error {
  constructor(message = "Overleaf session rejected — the cookie has probably expired. Paste a fresh one.") {
    super(message);
    this.name = "OverleafAuthError";
  }
}

/** The instance does not offer this feature (HTTP 404: older Overleaf, or the thread is gone). */
export class OverleafFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverleafFeatureError";
  }
}

/** Overleaf refused the action for this account (HTTP 403). The session itself is fine. */
export class OverleafPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverleafPermissionError";
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
  /** The project's compiler setting from joinProject, when the server sends one. */
  compiler?: string;
  /** Entity id of the project's main document (joinProject rootDoc_id), when set. */
  rootDocId?: string;
}

/** A review comment anchored in a doc: its thread id and the quoted text. */
export interface DocComment {
  /** Range id; usually the thread id. */
  id: string;
  threadId: string;
  quote: string;
  /** Character offset into the doc's (visible) text. */
  offset: number;
  /** history-OT docs carry the resolved flag on the range itself. */
  resolved?: boolean;
}

/** A tracked change in a doc. */
export interface DocChange {
  id: string;
  kind: "insert" | "delete";
  text: string;
  /** Character offset into the doc's (visible) text. */
  offset: number;
  userId?: string;
  /** ISO time, when the server reports one. */
  time?: string;
}

export interface DocRanges {
  comments: DocComment[];
  changes: DocChange[];
}

/** A doc as joinDoc returns it. `lines` is always the visible text. */
export interface OlDocSnapshot {
  lines: string[];
  version: number;
  /** "sharejs-text-ot" (classic) or "history-ot" (newer docs). */
  type: "sharejs-text-ot" | "history-ot";
  ranges: DocRanges;
  /** history-OT only: the stored content, which also keeps tracked-deleted text. */
  historyContent?: string;
  /** history-OT only: the tracked-deleted spans of historyContent. */
  hiddenSpans?: ContentSpan[];
}

export interface OlThreadUser {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface OlThreadMessage {
  id: string;
  content: string;
  /** ISO time. */
  time?: string;
  userId?: string;
  user?: OlThreadUser;
}

export interface OlThread {
  messages: OlThreadMessage[];
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: OlThreadUser;
}

/** Overleaf entity/thread ids are hex ObjectIds; anything path-like is refused. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

/** How long downloadZip waits out Overleaf's download rate limit in total. */
export const ZIP_RATE_LIMIT_WAIT_MS = 65_000;

/** A Retry-After header (seconds or an HTTP date) in milliseconds, capped at 30 s; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 250), 30_000);
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

  /**
   * Like fetchChecked, but a 403 is NOT a dead session here: review actions
   * answer 403 when the account lacks comment rights. Only 401 and a login
   * page count as an expired session.
   */
  private async fetchReview(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.baseUrl + path, {
      redirect: "follow",
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(30_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 401 || (res.ok && ct.includes("text/html") && res.url.includes("/login"))) {
      throw new OverleafAuthError();
    }
    return res;
  }

  /**
   * All comment threads of a project with their messages (GET
   * /project/:id/threads). Each message carries the author's name when the
   * server includes it. Throws OverleafFeatureError on instances without the
   * endpoint, OverleafPermissionError when the account may not read them.
   */
  async getThreads(projectId: string): Promise<Map<string, OlThread>> {
    const res = await this.fetchReview(`/project/${projectId}/threads`, { headers: { Accept: "application/json" } });
    if (res.status === 404) {
      throw new OverleafFeatureError(
        "This Overleaf instance has no comment-threads API (Community Edition and older versions have none), so comment messages cannot be shown",
      );
    }
    if (res.status === 403) {
      throw new OverleafPermissionError("Overleaf does not let this account read the project's comments");
    }
    if (!res.ok) throw new Error(`reading comment threads failed: HTTP ${res.status}`);
    const data: unknown = await res.json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("reading comment threads failed: unexpected response");
    }
    const threads = new Map<string, OlThread>();
    for (const [id, raw] of Object.entries(data as Record<string, any>)) {
      if (!raw || typeof raw !== "object") continue;
      threads.set(id, {
        messages: (Array.isArray(raw.messages) ? raw.messages : [])
          .filter((m: any) => m && typeof m === "object")
          .map((m: any) => ({
            id: String(m.id ?? m._id ?? ""),
            content: typeof m.content === "string" ? m.content : "",
            time: isoTime(m.timestamp),
            userId: m.user_id != null ? String(m.user_id) : (m.user?.id != null ? String(m.user.id) : undefined),
            user: threadUser(m.user),
          })),
        resolved: raw.resolved === true,
        resolvedAt: isoTime(raw.resolved_at),
        resolvedBy: threadUser(raw.resolved_by_user),
      });
    }
    return threads;
  }

  /** Reply to a comment thread. */
  async postThreadMessage(projectId: string, threadId: string, content: string): Promise<void> {
    if (!SAFE_ID.test(threadId)) throw new Error("invalid thread id");
    await this.reviewPost(`/project/${projectId}/thread/${threadId}/messages`, { content }, "reply to the comment");
  }

  /** Resolve (resolved=true) or reopen a comment thread anchored in `docId`. */
  async setThreadResolved(projectId: string, docId: string, threadId: string, resolved: boolean): Promise<void> {
    if (!SAFE_ID.test(threadId) || !SAFE_ID.test(docId)) throw new Error("invalid thread or doc id");
    await this.reviewPost(
      `/project/${projectId}/doc/${docId}/thread/${threadId}/${resolved ? "resolve" : "reopen"}`,
      undefined,
      resolved ? "resolve the comment" : "reopen the comment",
    );
  }

  /**
   * The project's newest history version, after asking Overleaf to move
   * pending edits into its history (POST /project/:id/flush, then GET
   * /project/:id/updates). Null when the history has no update yet.
   */
  async latestHistoryVersion(projectId: string): Promise<number | null> {
    const token = await this.csrf();
    const flush = await this.fetchReview(`/project/${projectId}/flush`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: "{}",
    });
    if (flush.status === 404) {
      throw new OverleafFeatureError("this Overleaf instance has no project history API (probably an older version)");
    }
    if (flush.status === 403) throw new OverleafPermissionError("Overleaf does not let this account read the project history");
    if (!flush.ok) throw new Error(`moving recent edits into the project history failed: HTTP ${flush.status}`);
    const res = await this.fetchReview(`/project/${projectId}/updates?min_count=1`, { headers: { Accept: "application/json" } });
    if (res.status === 403) throw new OverleafPermissionError("Overleaf does not let this account read the project history");
    if (!res.ok) throw new Error(`reading the project history failed: HTTP ${res.status}`);
    const data: any = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.updates)) throw new Error("reading the project history failed: unexpected response");
    let latest: number | null = null;
    for (const u of data.updates) {
      const v = u?.toV;
      if (Number.isSafeInteger(v) && v >= 0 && (latest === null || v > latest)) latest = v;
    }
    return latest;
  }

  /** Add a named label at `version` of the project history (POST /project/:id/labels). */
  async addHistoryLabel(projectId: string, comment: string, version: number): Promise<void> {
    const token = await this.csrf();
    const res = await this.fetchReview(`/project/${projectId}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify({ comment, version }),
    });
    if (res.ok) return;
    if (res.status === 404) throw new OverleafFeatureError("this Overleaf instance does not support history labels");
    if (res.status === 403) throw new OverleafPermissionError("Overleaf does not let this account add history labels to the project");
    const text = await res.text().catch(() => "");
    throw new Error(`adding the history label failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
  }

  private async reviewPost(path: string, body: unknown, what: string): Promise<void> {
    const token = await this.csrf();
    const res = await this.fetchReview(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return;
    if (res.status === 404) {
      throw new OverleafFeatureError(
        `Could not ${what}: this Overleaf instance does not support it (older version), or the comment no longer exists`,
      );
    }
    if (res.status === 403) {
      throw new OverleafPermissionError(`Could not ${what}: Overleaf refused it for this account (no comment permission on this project?)`);
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Could not ${what}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
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

  /**
   * The project as a zip. Overleaf allows 10 project downloads per minute per
   * project (HTTP 429 beyond that); BlattBot downloads on every sync, approve
   * and conflict resolution, so a burst of small approvals can reach it. Wait
   * as Overleaf asks (Retry-After, capped) for up to ZIP_RATE_LIMIT_WAIT_MS
   * in total before giving up with a clear message.
   */
  async downloadZip(projectId: string, opts: { rateLimitWaitMs?: number } = {}): Promise<Buffer> {
    const deadline = Date.now() + (opts.rateLimitWaitMs ?? ZIP_RATE_LIMIT_WAIT_MS);
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await this.fetchChecked(`/project/${projectId}/download/zip`, {
        headers: { Accept: "application/zip, */*" },
      });
      if (res.status !== 429) break;
      await res.arrayBuffer().catch(() => undefined);
      const wait = retryAfterMs(res.headers.get("retry-after")) ?? Math.min(2000 * 2 ** attempt, 15_000);
      if (Date.now() + wait > deadline) {
        throw new Error(
          "Overleaf limits project downloads to 10 per minute and BlattBot reached that limit; wait a minute, then try again",
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    }
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

  /** Make `docId` the project's main document (POST /project/:id/settings {rootDocId}). */
  async setRootDoc(projectId: string, docId: string): Promise<void> {
    if (!SAFE_ID.test(docId)) throw new Error("invalid doc id");
    const token = await this.csrf();
    const res = await this.fetchChecked(`/project/${projectId}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": token },
      body: JSON.stringify({ rootDocId: docId }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`setting the main document failed: HTTP ${res.status}`);
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

  /** Docs this session has seen to be history-OT: joined with supportsHistoryOT straight away. */
  private readonly historyOtDocs = new Set<string>();

  /**
   * Join a doc: its decoded text lines, OT version, doc type, and review
   * ranges (comments, tracked changes). The ack is
   * `[err, lines, version, ops, ranges, type, opts]`; older servers stop
   * after the version. A history-OT doc refuses a plain join ("client does
   * not support history-ot"), so that error retries with supportsHistoryOT.
   */
  async joinDoc(docId: string): Promise<OlDocSnapshot> {
    const historyOpts = { encodeRanges: true, supportsHistoryOT: true };
    let args: any[];
    if (this.historyOtDocs.has(docId)) {
      args = await this.emit("joinDoc", [docId, historyOpts]);
    } else {
      try {
        args = await this.emit("joinDoc", [docId, { encodeRanges: true }]);
      } catch (err: any) {
        if (!/does not support history-ot/i.test(String(err?.message ?? err))) throw err;
        this.historyOtDocs.add(docId);
        args = await this.emit("joinDoc", [docId, historyOpts]);
      }
    }
    return parseJoinDocAck(docId, args);
  }

  /**
   * Apply a sharejs text op at the given doc version. With `meta.tc` (an
   * 18-hex id seed) Overleaf records the op as a tracked change. Overleaf
   * reports failures either as an error ack or as a separate otUpdateError
   * event — either one within the wait window rejects. NB: on real servers a
   * success ack only means the op was ENQUEUED (document-updater applies it
   * asynchronously) — callers must verify via a fresh joinDoc and the
   * session's otUpdateError field.
   */
  async applyOtUpdate(docId: string, op: TextOpComponent[], version: number, meta?: { tc: string }): Promise<void> {
    await this.sendUpdate(docId, { doc: docId, op, v: version, ...(meta ? { meta } : {}) });
  }

  /** Apply a history-OT text operation (retain/insert/delete) at the given version; same caveats. */
  async applyHistoryOtUpdate(docId: string, textOperation: (number | string)[], version: number): Promise<void> {
    await this.sendUpdate(docId, { doc: docId, op: [{ textOperation }], v: version });
  }

  private async sendUpdate(docId: string, update: Record<string, unknown>): Promise<void> {
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
      await Promise.race([this.emit("applyOtUpdate", [docId, update]), otError]);
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

/** The file tree (and compiler / root doc settings) of a joinProject project object. */
export function buildTree(project: any): ProjectTree {
  const root = project?.rootFolder?.[0];
  if (!root?._id) throw new Error("project tree missing rootFolder");
  const tree: ProjectTree = {
    rootFolderId: String(root._id),
    entities: new Map(),
    folders: new Map([["", String(root._id)]]),
    ...(typeof project.compiler === "string" && project.compiler ? { compiler: project.compiler } : {}),
    ...(project.rootDoc_id ? { rootDocId: String(project.rootDoc_id) } : {}),
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

/** A timestamp (ms number, ISO string, or Date JSON) as ISO; undefined when unusable. */
function isoTime(v: unknown): string | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function threadUser(u: any): OlThreadUser | undefined {
  if (!u || typeof u !== "object") return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const user: OlThreadUser = {
    id: u.id != null ? String(u.id) : u._id != null ? String(u._id) : undefined,
    firstName: str(u.first_name),
    lastName: str(u.last_name),
    email: str(u.email),
  };
  return user.id || user.firstName || user.lastName || user.email ? user : undefined;
}

/**
 * sharejs-style ranges (`{comments: [{id, op: {c, p, t}}], changes: [{id,
 * op: {p, i|d}, metadata: {user_id, ts}}]}`). With encodeRanges the quoted
 * and changed text is escaped like the doc lines. Malformed entries are skipped.
 */
function parseShareJsRanges(raw: any, escaped: boolean): DocRanges {
  const text = (v: unknown) => (typeof v === "string" ? (escaped ? decodeSocketLine(v) : v) : undefined);
  const comments: DocComment[] = [];
  for (const c of Array.isArray(raw?.comments) ? raw.comments : []) {
    const op = c?.op;
    if (typeof op?.p !== "number") continue;
    const threadId = op.t != null ? String(op.t) : c.id != null ? String(c.id) : "";
    if (!threadId) continue;
    comments.push({ id: String(c.id ?? threadId), threadId, quote: text(op.c) ?? "", offset: op.p });
  }
  const changes: DocChange[] = [];
  for (const ch of Array.isArray(raw?.changes) ? raw.changes : []) {
    const op = ch?.op;
    if (typeof op?.p !== "number") continue;
    const inserted = text(op.i);
    const deleted = text(op.d);
    if (inserted === undefined && deleted === undefined) continue;
    changes.push({
      id: String(ch.id ?? ""),
      kind: inserted !== undefined ? "insert" : "delete",
      text: inserted ?? deleted ?? "",
      offset: op.p,
      userId: ch.metadata?.user_id != null ? String(ch.metadata.user_id) : undefined,
      time: isoTime(ch.metadata?.ts),
    });
  }
  return { comments, changes };
}

/**
 * A history-OT doc's snapshot: either plain lines or the stored file data
 * `{content, comments?: [{id, ranges: [{pos, length}], resolved?}],
 * trackedChanges?: [{range: {pos, length}, tracking: {type, userId, ts}}]}`.
 * Tracked deletes stay in the content; the visible text leaves them out and
 * every offset reported here is in visible-text coordinates.
 */
function parseHistorySnapshot(raw: any, sharedRanges: any): Omit<OlDocSnapshot, "version" | "type"> | null {
  let content: string;
  if (Array.isArray(raw)) content = raw.map(String).join("\n");
  else if (typeof raw === "string") content = raw;
  else if (raw && typeof raw === "object" && typeof raw.content === "string") content = raw.content;
  else return null;
  const span = (r: any): ContentSpan | null =>
    typeof r?.pos === "number" && typeof r?.length === "number" ? { pos: r.pos, length: r.length } : null;
  const tracked: any[] = Array.isArray(raw?.trackedChanges) ? raw.trackedChanges : [];
  const hidden = normalizeSpans(
    tracked.filter((t) => t?.tracking?.type === "delete").map((t) => span(t.range)).filter((s): s is ContentSpan => s !== null),
    content.length,
  );
  const visible = withoutSpans(content, hidden);
  /** Content offset → visible offset. */
  const toVisible = (pos: number) => {
    let out = Math.max(0, Math.min(content.length, pos));
    for (const h of hidden) {
      if (h.pos >= pos) break;
      out -= Math.min(h.length, pos - h.pos);
    }
    return out;
  };
  const visibleSlice = (s: ContentSpan) => visible.slice(toVisible(s.pos), toVisible(s.pos + s.length));
  let ranges: DocRanges = { comments: [], changes: [] };
  if (Array.isArray(raw?.comments) || tracked.length > 0) {
    for (const c of Array.isArray(raw?.comments) ? raw.comments : []) {
      const first = span(Array.isArray(c?.ranges) ? c.ranges[0] : null);
      if (!c?.id || !first) continue;
      ranges.comments.push({
        id: String(c.id),
        threadId: String(c.id),
        quote: visibleSlice(first),
        offset: toVisible(first.pos),
        ...(c.resolved === true ? { resolved: true } : {}),
      });
    }
    for (const t of tracked) {
      const s = span(t?.range);
      const type = t?.tracking?.type;
      if (!s || (type !== "insert" && type !== "delete")) continue;
      ranges.changes.push({
        id: `${type}-${s.pos}-${s.length}`,
        kind: type,
        text: content.slice(s.pos, s.pos + s.length),
        offset: toVisible(s.pos),
        userId: t.tracking.userId != null ? String(t.tracking.userId) : undefined,
        time: isoTime(t.tracking.ts),
      });
    }
  } else {
    ranges = parseShareJsRanges(sharedRanges, false);
  }
  return { lines: visible.split("\n"), ranges, historyContent: content, hiddenSpans: hidden };
}

/** Parse a joinDoc ack defensively: everything after the version is optional. */
export function parseJoinDocAck(docId: string, args: any[]): OlDocSnapshot {
  const version = args?.[2];
  if (typeof version !== "number") throw new Error(`joinDoc ${docId}: unexpected ack ${JSON.stringify(args).slice(0, 300)}`);
  if (args?.[5] === "history-ot") {
    const parsed = parseHistorySnapshot(args?.[1], args?.[4]);
    if (!parsed) throw new Error(`joinDoc ${docId}: unexpected history-ot snapshot`);
    return { ...parsed, version, type: "history-ot" };
  }
  const lines = args?.[1];
  if (!Array.isArray(lines)) throw new Error(`joinDoc ${docId}: unexpected ack ${JSON.stringify(args).slice(0, 300)}`);
  return {
    lines: lines.map((l) => decodeSocketLine(String(l))),
    version,
    type: "sharejs-text-ot",
    ranges: parseShareJsRanges(args?.[4], true),
  };
}

/**
 * An 18-hex-char id seed for tracked changes (`meta.tc`): 8 hex unix seconds
 * + 10 random hex. Overleaf appends a 6-hex counter to form each change id.
 */
export function generateIdSeed(): string {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0").slice(-8);
  const rand = (digits: number) =>
    Math.floor(Math.random() * 16 ** digits).toString(16).padStart(digits, "0");
  return seconds + rand(6) + rand(4);
}
