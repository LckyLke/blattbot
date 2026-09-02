export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  kind: "git" | "overleaf" | "local";
  mainTex?: string;
  sessionId?: string;
  createdAt: string;
  hasToken: boolean;
  overleafBaseUrl?: string;
  overleafProjectId?: string;
  accountId?: string;
  /** Cumulative agent cost/turn totals — updated at every turn end. */
  stats?: ProjectStats;
}

/** Cumulative agent usage of a project (cost known only on the Claude backend). */
export interface ProjectStats {
  totalCostUsd: number;
  totalTurns: number;
}

/** A signed-in Overleaf instance session (cookie stays on the server). */
export interface Account {
  id: string;
  baseUrl: string;
  host: string;
  email?: string;
  status: "connected" | "disconnected";
  createdAt: string;
  lastVerifiedAt?: string;
  projectCount: number;
}

export interface Settings {
  model: string;
  /** What the ACTIVE backend actually runs: "" and tier aliases resolved for
   *  claude, the configured id verbatim for openai. */
  resolvedModel: string;
  hasApiKey: boolean;
  hasS2ApiKey: boolean;
  anthropicBaseUrl: string;
  systemPromptAppend: string;
  engine: "" | "tectonic" | "latexmk" | "pdflatex";
  settingsPath: string;
  /** Agent backend: "" = Claude Agent SDK (the default). */
  backend: "" | "claude" | "openai";
  openaiBaseUrl: string;
  openaiModel: string;
  hasOpenaiApiKey: boolean;
}

/** A persistent conversation of a project (session id stays on the server). */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Running cost/token totals (absent until the first completed turn). */
  stats?: { costUsd: number; inputTokens: number; outputTokens: number; turns: number };
}

/** Deterministic aggregate behind the AI-use disclosure text. */
export interface DisclosureFacts {
  turns: number;
  chats: number;
  modes: string[];
  models: string[];
  filesTouched: number;
  firstUse: string | null;
  lastUse: string | null;
}

/** One persisted transcript event, as stored in the chat's .jsonl. */
export interface ChatTranscriptEvent {
  type: string;
  [key: string]: unknown;
}

/** One choice of a mid-turn agent question. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One question the agent asked mid-turn (AskUserQuestion / ask_user). */
export interface AgentQuestion {
  /** Full question text — also the key of the answers record. */
  question: string;
  /** Short chip label (≤12 chars). */
  header: string;
  options: QuestionOption[];
  /** Multi-select answers are comma-joined into one string. */
  multiSelect: boolean;
}

/** The turn's unanswered question, included in the project detail while pending. */
export interface PendingQuestion {
  questionId: string;
  questions: AgentQuestion[];
  createdAt: string;
}

export interface AgentInfo {
  /** Backend id string, e.g. "claude-agent-sdk" or "openai-compatible". */
  backend: string;
  backendLabel?: string;
  backendDescription: string;
  model: string;
  usingApiKey: boolean;
  /** The endpoint the active backend talks to. */
  endpoint?: string;
  /** Claude backend only (legacy field, same value as endpoint). */
  anthropicBaseUrl?: string;
  /** Claude backend only — the SDK's system-prompt preset. */
  systemPromptPreset?: string;
  systemPromptAppend: string;
  userSystemPromptAppend: string;
  /** OpenAI backend only — how conversation memory works. */
  sessionNote?: string;
  tools: { name: string; description: string }[];
  modes: { id: string; label: string; description: string; prompt: string; readOnly?: boolean }[];
  disallowedTools: string[];
  dataDir: string;
  projectsDir: string;
}

/** A project as listed on an Overleaf dashboard (not yet connected). */
export interface OlProject {
  id: string;
  name: string;
  lastUpdated?: string;
  archived?: boolean;
  trashed?: boolean;
}

/** External read-only context attached to a project. */
export interface ProjectContext {
  links: { path: string; exists: boolean; kind: "dir" | "file" | "missing" }[];
  uploads: { name: string; size: number }[];
}

/** One step of the folder picker: the subdirectories of `path`. */
export interface DirListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  content: string;
}

export interface ProjectDetail extends Project {
  files: string[];
  turnActive: boolean;
  /** The turn's unanswered mid-turn question (null unless a turn is blocked on one). */
  pendingQuestion?: PendingQuestion | null;
  hasChanges: boolean;
  lastCompile: CompileInfo | null;
}

export interface CompileInfo {
  ok: boolean;
  engine: string;
  mainTex: string;
  errors: string[];
  logTail: string;
  durationMs: number;
  hasPdf: boolean;
}

export interface BibEntry {
  file: string;
  key: string;
  type: string;
  title: string | null;
  author: string | null;
  year: string | null;
  doi: string | null;
}

export interface RefUsage {
  file: string;
  count: number;
  /** 1-indexed line of each citing command, one per occurrence. */
  lines: number[];
}

export interface RefEntry extends BibEntry {
  /** Best web link: doi.org → url field → arXiv abstract page. */
  link: string | null;
  usage: RefUsage[];
  /** The entry's exact BibTeX source text, for in-place editing. */
  raw: string;
  summary?: string;
  summarySource?: string;
  hasPdf: boolean;
}

export type AuditStatus = "verified" | "mismatch" | "unresolved" | "skipped";

export interface AuditResult {
  status: AuditStatus;
  /** Human explanation — e.g. both titles on a mismatch. */
  detail?: string;
  /** Evidence link (doi.org / OpenAlex / arXiv) when available. */
  url?: string;
  /** The user judged this entry sound despite the audit's verdict. */
  accepted?: boolean;
}

/** The persisted outcome of the last citation audit (deterministic, no LLM). */
export interface CitationAudit {
  at: string;
  results: Record<string, AuditResult>;
}

export type CitationVerdict = "supported" | "partially_supported" | "not_supported" | "unclear";

/** Result of checking one claim against a cited paper's own content — not persisted. */
export interface CitationCheckResult {
  verdict: CitationVerdict;
  explanation: string;
  basis: "full_text" | "abstract";
}

/** One entry's result in a project-wide "verify all" sweep. */
export interface ClaimAuditEntry extends CitationCheckResult {
  claim: string;
  file: string;
  line: number;
}

/** The persisted outcome of the last project-wide claim-verification sweep. */
export interface ClaimAudit {
  at: string;
  results: Record<string, ClaimAuditEntry>;
  /** Cite keys with no \cite site — nothing to check a claim against. */
  skipped: string[];
}

export interface RefsResponse {
  entries: RefEntry[];
  undefinedKeys: { key: string; files: string[] }[];
  unusedCount: number;
  audit: CitationAudit | null;
  claimAudit: ClaimAudit | null;
}

export interface ImportBibResult {
  added: string[];
  skipped: { key: string; reason: string }[];
  bibFile: string;
}

/** Per-project settings. Absent fields = not set (global defaults apply). */
export interface ProjectSettings {
  /** Writing style / instructions appended to this project's system prompt. */
  styleAppend?: string;
  /** Model override for this project (raw value — may be an alias). */
  model?: string;
  /** Mode preselected for new chats in this project ("" = Edit). */
  defaultMode?: string;
  /** The model a turn on THIS project runs: override → global, aliases resolved. */
  resolvedModel: string;
}

/** An image attached to a chat message (stored outside the project tree). */
export interface ChatImage {
  id: string;
  /** Server route the thumbnail/full view loads from. */
  url: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** The accepted attachment types and caps — mirrored from chatimages.ts. */
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_CHAT_IMAGES = 4;
/**
 * Per-image cap, and it is NOT a round number by accident: both backends put
 * the picture on the wire base64-encoded (~4/3 of the raw bytes) and the
 * Anthropic API rejects an image block over 5 MiB encoded. 3.5 MB raw stays
 * comfortably inside that. Bigger pictures are downscaled in the browser
 * before upload (see downscaleImageFile) rather than simply refused.
 */
export const MAX_CHAT_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** The cap as the composer spells it ("3.5 MB"). */
export const MAX_CHAT_IMAGE_LABEL = `${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB`;

/** A file both Overleaf and the local tree changed since the last sync. */
export interface SyncConflict {
  path: string;
  /** "deleted-remote" = the file was deleted on Overleaf but edited locally. */
  kind: "modified" | "deleted-remote";
}

/** Approve was refused (HTTP 409): remote edits overlap the local ones. */
export class ApproveConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: SyncConflict[],
  ) {
    super(message);
    this.name = "ApproveConflictError";
  }
}

let authReady: Promise<void> | null = null;

/**
 * One-time same-origin token handoff: /api/bootstrap sets the SameSite=Strict
 * auth cookie every later request (fetch, href downloads, the websocket)
 * carries automatically. Cross-site pages can neither read nor send it.
 */
export function ensureAuth(): Promise<void> {
  authReady ??= fetch("/api/bootstrap")
    .then((r) => {
      if (!r.ok) throw new Error(`bootstrap failed: HTTP ${r.status}`);
    })
    .catch((err) => {
      authReady = null; // allow a retry on the next call
      throw err;
    });
  return authReady;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await ensureAuth();
  const res = await fetch(path, {
    ...init,
    // Explicit headers win — raw uploads post bytes, not JSON.
    headers: init?.headers ?? (init?.body ? { "Content-Type": "application/json" } : undefined),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* not json */
    }
    // The generic API 404 means the route doesn't exist — i.e. the backend
    // predates this frontend. Say so instead of a bare "not found".
    if (res.status === 404 && message === "not found") {
      message = "The BlattBot server is running an older version — restart it and try again.";
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; engine: string | null }>("/api/health"),
  version: () => request<{ current: string; latest: string | null }>("/api/version"),
  projects: () => request<Project[]>("/api/projects"),
  project: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  addProject: (body: {
    name?: string;
    url?: string;
    token?: string;
    cookie?: string;
    accountId?: string;
    projectId?: string;
    local?: boolean;
  }) => request<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  publishProject: (id: string, accountId: string) =>
    request<{ project: Project; uploaded: string[]; warnings: string[] }>(
      `/api/projects/${id}/publish`,
      { method: "POST", body: JSON.stringify({ accountId }) },
    ),
  accounts: () => request<Account[]>("/api/accounts"),
  addAccount: (url: string, cookie: string) =>
    request<Account>("/api/accounts", { method: "POST", body: JSON.stringify({ url, cookie }) }),
  refreshAccount: (id: string, mode: "import" | "browser") =>
    request<Account>(`/api/accounts/${id}/refresh`, { method: "POST", body: JSON.stringify({ mode }) }),
  deleteAccount: (id: string) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" }),
  accountProjects: (id: string) =>
    request<{ baseUrl: string; projects: OlProject[] }>(`/api/accounts/${id}/projects`),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (
    patch: Partial<
      Omit<Settings, "hasApiKey" | "hasS2ApiKey" | "hasOpenaiApiKey" | "settingsPath">
    > & {
      apiKey?: string;
      s2ApiKey?: string;
      openaiApiKey?: string;
    },
  ) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  agentInfo: () => request<AgentInfo>("/api/agent/info"),
  updateCookie: (id: string, cookie: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ cookie }) }),
  cookieImport: (url: string) =>
    request<{ cookie: string; source: string }>("/api/cookies/import", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  olProjects: (url: string, cookie: string) =>
    request<{ baseUrl: string; projects: OlProject[] }>("/api/overleaf/projects", {
      method: "POST",
      body: JSON.stringify({ url, cookie }),
    }),
  file: (id: string, path: string) =>
    request<FileContent>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  context: (id: string) => request<ProjectContext>(`/api/projects/${id}/context`),
  browseDirs: (path?: string) =>
    request<DirListing>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addContextLink: (id: string, path: string) =>
    request<ProjectContext>(`/api/projects/${id}/context/link`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  removeContextLink: (id: string, path: string) =>
    request<ProjectContext>(`/api/projects/${id}/context/link?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  uploadContext: (id: string, name: string, body: { text?: string; contentBase64?: string }) =>
    request<ProjectContext>(`/api/projects/${id}/context/upload`, {
      method: "POST",
      body: JSON.stringify({ name, ...body }),
    }),
  deleteContextUpload: (id: string, name: string) =>
    request<ProjectContext>(`/api/projects/${id}/context/upload/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  saveFile: (id: string, path: string, content: string) =>
    request<{ ok: boolean; diff: string }>(`/api/projects/${id}/file`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  cookieViaBrowser: (url: string) =>
    request<{ cookie: string; source: string }>("/api/cookies/browser", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  chat: (id: string, message: string, mode?: string, files?: string[], images?: string[]) =>
    request<{ ok: boolean }>(`/api/projects/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message, mode, files, images }),
    }),
  /** Post one image's raw bytes; the server sniffs the type and names the file. */
  uploadChatImage: (id: string, file: Blob) =>
    request<ChatImage>(`/api/projects/${id}/chat-image`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    }),
  chatImageUrl: (id: string, imageId: string) =>
    `/api/projects/${id}/chat-image/${encodeURIComponent(imageId)}`,
  chats: (id: string) =>
    request<{ chats: ChatMeta[]; activeChatId: string }>(`/api/projects/${id}/chats`),
  createChat: (id: string) => request<ChatMeta>(`/api/projects/${id}/chats`, { method: "POST" }),
  activateChat: (id: string, chatId: string) =>
    request<{ ok: boolean; activeChatId: string }>(
      `/api/projects/${id}/chats/${encodeURIComponent(chatId)}/activate`,
      { method: "POST" },
    ),
  chatTranscript: (id: string, chatId: string) =>
    request<{ events: ChatTranscriptEvent[] }>(
      `/api/projects/${id}/chats/${encodeURIComponent(chatId)}/transcript`,
    ),
  deleteChat: (id: string, chatId: string) =>
    request<{ ok: boolean; chats: ChatMeta[]; activeChatId: string }>(
      `/api/projects/${id}/chats/${encodeURIComponent(chatId)}`,
      { method: "DELETE" },
    ),
  interrupt: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/interrupt`, { method: "POST" }),
  answerQuestion: (id: string, questionId: string, answers: Record<string, string>) =>
    request<{ ok: boolean }>(
      `/api/projects/${id}/question/${encodeURIComponent(questionId)}`,
      { method: "POST", body: JSON.stringify({ answers }) },
    ),
  dismissQuestion: (id: string, questionId: string) =>
    request<{ ok: boolean }>(
      `/api/projects/${id}/question/${encodeURIComponent(questionId)}/dismiss`,
      { method: "POST" },
    ),
  disclosure: (id: string) =>
    request<{ text: string; facts: DisclosureFacts }>(`/api/projects/${id}/disclosure`, {
      method: "POST",
    }),
  diff: (id: string) => request<{ diff: string }>(`/api/projects/${id}/diff`),
  /**
   * Approve & push. A 409 carrying `conflicts` (Overleaf changed files the
   * local tree also edited) throws ApproveConflictError so the Proof view can
   * offer per-file discard or a forced overwrite; other errors throw plainly.
   */
  approve: async (id: string, message: string, force = false) => {
    await ensureAuth();
    const res = await fetch(`/api/projects/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, force }),
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* not json */
      }
      const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      if (res.status === 409 && Array.isArray(body?.conflicts)) {
        throw new ApproveConflictError(reason, body.conflicts as SyncConflict[]);
      }
      throw new Error(reason);
    }
    return (await res.json()) as {
      ok: boolean;
      pushed: boolean;
      warnings?: string[];
      absorbedRemote?: string[];
    };
  },
  reject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/reject`, { method: "POST" }),
  rejectFile: (id: string, path: string) =>
    request<{ ok: boolean; diff: string }>(`/api/projects/${id}/reject-file`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  rejectHunk: (id: string, patch: string) =>
    request<{ ok: boolean; diff: string }>(`/api/projects/${id}/reject-hunk`, {
      method: "POST",
      body: JSON.stringify({ patch }),
    }),
  sync: (id: string) =>
    request<{ ok: boolean; output: string; changed?: boolean; merged?: string[]; drift?: string[] }>(
      `/api/projects/${id}/sync`,
      { method: "POST" },
    ),
  compile: (id: string) => request<CompileInfo>(`/api/projects/${id}/compile`, { method: "POST" }),
  /**
   * Compile the project's state as committed at a rev (only "HEAD" — the
   * approval base — for now) into the server's per-sha cache. ok:true means
   * the build is fetchable via /pdf?rev=<sha>; otherwise log carries the tail.
   */
  compileRev: (id: string, rev = "HEAD") =>
    request<{ ok: boolean; sha: string; log?: string }>(`/api/projects/${id}/compile-rev`, {
      method: "POST",
      body: JSON.stringify({ rev }),
    }),
  /**
   * "Verify on Overleaf": run Overleaf's own compiler on the project's current
   * REMOTE state. pdf:true = the build is fetchable via /pdf?source=remote;
   * otherwise logTail carries the tail of the remote compile log.
   */
  remoteCompile: (id: string) =>
    request<{ status: string; pdf: boolean; logTail?: string }>(
      `/api/projects/${id}/remote-compile`,
      { method: "POST" },
    ),
  bib: (id: string) => request<{ entries: BibEntry[] }>(`/api/projects/${id}/bib`),
  refs: (id: string) => request<RefsResponse>(`/api/projects/${id}/refs`),
  auditRefs: (id: string) =>
    request<CitationAudit>(`/api/projects/${id}/refs/audit`, { method: "POST" }),
  /** Project-wide claim check: every cited entry against its first \cite site. Slow — reads each paper. */
  verifyAllRefs: (id: string) =>
    request<ClaimAudit>(`/api/projects/${id}/refs/verify-all`, { method: "POST" }),
  acceptAudit: (id: string, key: string) =>
    request<{ key: string; audit: CitationAudit }>(`/api/projects/${id}/refs/audit/accept`, {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  tldr: (id: string, key: string, force = false) =>
    request<{ summary: string; source: string }>(
      `/api/projects/${id}/refs/${encodeURIComponent(key)}/tldr`,
      { method: "POST", body: JSON.stringify({ force }) },
    ),
  fetchRefPdf: (id: string, key: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/refs/${encodeURIComponent(key)}/pdf`, {
      method: "POST",
    }),
  refPdfUrl: (id: string, key: string) =>
    `/api/projects/${id}/refs/${encodeURIComponent(key)}/pdf`,
  /** Manual, on-demand check of a specific claim against the paper's own content. */
  verifyRef: (id: string, key: string, claim: string) =>
    request<CitationCheckResult>(`/api/projects/${id}/refs/${encodeURIComponent(key)}/verify`, {
      method: "POST",
      body: JSON.stringify({ claim }),
    }),
  addRef: (id: string, bibtex: string, bibFile?: string) =>
    request<{ ok: boolean; key: string; diff: string }>(`/api/projects/${id}/refs`, {
      method: "POST",
      body: JSON.stringify({ bibtex, bibFile }),
    }),
  updateRef: (id: string, key: string, bibtex: string) =>
    request<{ ok: boolean; key: string; diff: string }>(
      `/api/projects/${id}/refs/${encodeURIComponent(key)}`,
      { method: "PUT", body: JSON.stringify({ bibtex }) },
    ),
  deleteRef: (id: string, key: string) =>
    request<{ ok: boolean; diff: string }>(`/api/projects/${id}/refs/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  importBib: (id: string, bibtex: string, bibFile?: string) =>
    request<ImportBibResult>(`/api/projects/${id}/bib/import`, {
      method: "POST",
      body: JSON.stringify({ bibtex, bibFile }),
    }),
  exportBibUrl: (id: string) => `/api/projects/${id}/bib/export`,
  labels: (id: string) =>
    request<{ labels: { name: string; file: string; line: number }[] }>(
      `/api/projects/${id}/labels`,
    ),
  projectSettings: (id: string) => request<ProjectSettings>(`/api/projects/${id}/settings`),
  saveProjectSettings: (
    id: string,
    patch: { styleAppend?: string; model?: string; defaultMode?: string },
  ) =>
    request<ProjectSettings>(`/api/projects/${id}/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
};
