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
  /** What the agent actually runs: "" and tier aliases resolved server-side. */
  resolvedModel: string;
  hasApiKey: boolean;
  hasS2ApiKey: boolean;
  anthropicBaseUrl: string;
  systemPromptAppend: string;
  engine: "" | "tectonic" | "latexmk" | "pdflatex";
  settingsPath: string;
}

/** A persistent conversation of a project (session id stays on the server). */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** One persisted transcript event, as stored in the chat's .jsonl. */
export interface ChatTranscriptEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentInfo {
  backend: string;
  backendDescription: string;
  model: string;
  usingApiKey: boolean;
  anthropicBaseUrl: string;
  systemPromptPreset: string;
  systemPromptAppend: string;
  userSystemPromptAppend: string;
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

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  content: string;
}

export interface ProjectDetail extends Project {
  files: string[];
  turnActive: boolean;
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

export interface RefsResponse {
  entries: RefEntry[];
  undefinedKeys: { key: string; files: string[] }[];
  unusedCount: number;
}

export interface ImportBibResult {
  added: string[];
  skipped: { key: string; reason: string }[];
  bibFile: string;
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
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
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
    patch: Partial<Omit<Settings, "hasApiKey" | "hasS2ApiKey" | "settingsPath">> & {
      apiKey?: string;
      s2ApiKey?: string;
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
  chat: (id: string, message: string, mode?: string, files?: string[]) =>
    request<{ ok: boolean }>(`/api/projects/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message, mode, files }),
    }),
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
  diff: (id: string) => request<{ diff: string }>(`/api/projects/${id}/diff`),
  approve: (id: string, message: string) =>
    request<{ ok: boolean; pushed: boolean }>(`/api/projects/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
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
  sync: (id: string) => request<{ ok: boolean; output: string }>(`/api/projects/${id}/sync`, { method: "POST" }),
  compile: (id: string) => request<CompileInfo>(`/api/projects/${id}/compile`, { method: "POST" }),
  bib: (id: string) => request<{ entries: BibEntry[] }>(`/api/projects/${id}/bib`),
  refs: (id: string) => request<RefsResponse>(`/api/projects/${id}/refs`),
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
};
