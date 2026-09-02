import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProject,
  buildDir,
  ensureDirs,
  getProject,
  listProjects,
  projectDir,
  publicProject,
  removeProject,
  updateProject,
  type Project,
  type ProjectSettings,
} from "./config.js";
import * as git from "./git.js";
import { compileProject, compileRev, detectEngine, revPdfPath, type CompileResult } from "./compile.js";
import { findMainTex, listFiles, scanLabels } from "./latex.js";
import { locateInSources } from "./locate.js";
import {
  addRefEntry,
  deleteRefEntry,
  exportBibliography,
  importBibtex,
  readAllBibEntries,
  updateRefEntry,
} from "./citations.js";
import { collectCiteUsage, usageReport } from "./usage.js";
import {
  NoPdfError,
  RateLimitError,
  arxivIdFromEntry,
  acceptAuditEntry,
  auditCitations,
  ensurePaperPdf,
  getTldr,
  paperPdfPath,
  readAudit,
  readClaimAudit,
  readPaperStore,
  sanitizeKeyForFile,
  verifyAllCitations,
  verifyCitationSupport,
} from "./papers.js";
import type { BibEntry } from "./bib.js";
import {
  AGENT_MODES,
  AGENT_TOOL_INFO,
  DISALLOWED_TOOLS,
  MODEL_ALIASES,
  SYSTEM_APPEND,
  activeBackendId,
  beginTurnPipeline,
  endTurnPipeline,
  interruptTurn,
  isTurnActive,
  resolveBackendModel,
  resolveModel,
  runOneShot,
  runTurn,
  validateProjectSettingsPatch,
  validateScope,
  type AgentMode,
} from "./agent.js";
import { collectDisclosureFacts, composeDisclosure } from "./disclosure.js";
import {
  answerQuestion,
  dismissQuestion,
  pendingQuestion,
  questionStatus,
  validateAnswers,
} from "./questions.js";
import { ASK_USER_TOOL_INFO } from "./backends/types.js";
import { checkLatestVersion, currentVersion } from "./version.js";
import {
  MAX_HISTORY_MESSAGES,
  OPENAI_SYSTEM_PROMPT,
  OPENAI_TOOL_INFO,
  openaiBackend,
} from "./backends/openai.js";
import { claudeBackend } from "./backends/claude.js";
import { broadcast, subscribe } from "./events.js";
import {
  appendEvent,
  createChat,
  deleteChat,
  ensureActiveChat,
  getChat,
  listChats,
  publicChat,
  readTranscript,
  referencedImageIds,
  setActiveChat,
  updateChat,
} from "./chats.js";
import { makeTurnEventSink } from "./livediff.js";
import { OverleafAuthError, OverleafClient, canonicalOrigin, parseProjectUrl } from "./overleaf/olclient.js";
import { applySnapshot, unpackZip } from "./overleaf/olsync.js";
import { captureViaBrowser, importFromBrowsers } from "./overleaf/cookiegrab.js";
import * as sync from "./sync.js";
import {
  cookieWorks,
  getAccount,
  listAccounts,
  migrateProjectCookies,
  publicAccount,
  refreshFromBrowsers,
  removeAccount,
  updateAccount,
  upsertAccount,
} from "./accounts.js";
import { DATA_DIR, PROJECTS_DIR } from "./config.js";
import { AUTH_COOKIE, getAuthToken, hostAllowed, requestAuthorized } from "./auth.js";
import { loadSettings, publicSettings, saveSettings, type Settings } from "./settings.js";
import {
  browseDirectories,
  contextUploadsDir,
  deleteUpload,
  listContext,
  saveUpload,
  uploadPath,
  validateLinkPath,
} from "./context.js";
import {
  IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  deleteChatUploads,
  findChatImage,
  pruneOrphanChatUploads,
  resolveAttachments,
  saveChatImage,
  type TurnAttachment,
} from "./chatimages.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BLATTBOT_PORT ?? 4560);

ensureDirs();
migrateProjectCookies();
const AUTH_TOKEN = getAuthToken();

// bodyLimit covers base64-encoded context uploads (25 MB file ≈ 34 MB JSON).
const app = Fastify({ logger: { level: "warn" }, bodyLimit: 40 * 1024 * 1024 });
// Chat images are posted as raw bytes (no multipart parser, no new dependency).
// The declared type is never trusted — chatimages.ts sniffs the magic bytes —
// so this only decides which requests get a Buffer body at all.
app.addContentTypeParser(
  [...IMAGE_MIMES, "application/octet-stream"],
  { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES + 1024 },
  (_req, body, done) => done(null, body),
);
// CORS allowlist: the app itself plus the Vite dev server — never reflect-any.
await app.register(cors, {
  origin: [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    "http://127.0.0.1:4561",
    "http://localhost:4561",
  ],
});
await app.register(websocket);

// Local API security (see auth.ts): allowlisted Host header on everything
// (anti DNS-rebinding), and the local token on every /api request. The token
// reaches the app through /api/bootstrap — readable same-origin only — and
// rides along afterwards as a SameSite=Strict cookie, which cross-site pages
// can neither read nor send. Scripts use `Authorization: Bearer <token>`.
app.addHook("onRequest", async (req, reply) => {
  if (!hostAllowed(req.headers.host, PORT)) {
    return reply.code(403).send({ error: "forbidden host" });
  }
  const url = req.raw.url ?? "";
  if (!url.startsWith("/api/")) return; // the app shell itself
  if (url === "/api/bootstrap" || url.startsWith("/api/ws")) return; // ws checks at upgrade
  if (!requestAuthorized(req.headers)) {
    return reply.code(401).send({ error: "unauthorized — reload the BlattBot tab" });
  }
});

/** Same-origin token handoff: sets the auth cookie and returns the token. */
app.get("/api/bootstrap", async (req, reply) => {
  reply.header(
    "Set-Cookie",
    `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; SameSite=Strict; HttpOnly`,
  );
  return { ok: true, token: AUTH_TOKEN };
});

// Web UI: repo layout (web/dist as a sibling of server/, whether running from
// src/ via tsx or from the compiled dist/) or the published npm package
// (web-dist bundled next to dist/).
const webDistCandidates = [
  join(__dirname, "..", "..", "web", "dist"),
  join(__dirname, "..", "web-dist"),
];
const webDist = webDistCandidates.find((p) => existsSync(join(p, "index.html")));
if (webDist) {
  // @fastify/static serves everything with `cache-control: public, max-age=0`,
  // so the browser revalidates index.html on every load and cannot keep naming
  // asset hashes a newer build has replaced.
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    if (url.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    // A missing ASSET must 404, not fall back to index.html: handing HTML to a
    // script/module request produced the cryptic pdf.worker module-load error
    // instead of an honest "this file is gone — reload".
    if (url.startsWith("/assets/") || /\.[a-z0-9]{2,5}(\?|$)/i.test(url)) {
      reply.code(404).type("text/plain").send("not found");
      return;
    }
    reply.type("text/html").header("cache-control", "no-store").send(createReadStream(join(webDist, "index.html")));
  });
}

const lastCompile = new Map<string, CompileResult>();
/** Latest "Verify on Overleaf" build per project: the saved remote PDF's path. */
const lastRemoteCompile = new Map<string, string>();

function compilePublic(r: CompileResult) {
  const { pdfPath, ...rest } = r;
  return { ...rest, hasPdf: Boolean(pdfPath) };
}

app.get("/api/health", async () => {
  const engine = await detectEngine(loadSettings().engine || undefined);
  return { ok: true, engine: engine?.name ?? null };
});

// Update check: the npm lookup is warmed at boot (see the listen block) and
// cached for 24 h — this answers from that cache. latest is null when unknown.
app.get("/api/version", async () => ({
  current: currentVersion(),
  latest: await checkLatestVersion(),
}));

// ---- Settings & transparency ----------------------------------------------

// resolvedModel: what the active backend will actually run — "" and aliases
// resolved for claude, the configured id verbatim for openai.
app.get("/api/settings", async () => {
  const s = loadSettings();
  return { ...publicSettings(s), resolvedModel: resolveBackendModel(undefined, s) };
});

app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
  const s = saveSettings(req.body ?? {});
  return { ...publicSettings(s), resolvedModel: resolveBackendModel(undefined, s) };
});

// Reflects the ACTIVE backend (Settings → Agent): id, endpoint, model, tools.
app.get("/api/agent/info", async () => {
  const s = loadSettings();
  const common = {
    modes: AGENT_MODES,
    userSystemPromptAppend: s.systemPromptAppend,
    dataDir: DATA_DIR,
    projectsDir: PROJECTS_DIR,
  };
  if (activeBackendId(s) === "openai") {
    const base = s.openaiBaseUrl.trim().replace(/\/+$/, "");
    return {
      backend: "openai-compatible",
      backendLabel: openaiBackend.label,
      backendDescription: openaiBackend.description,
      model: s.openaiModel.trim() || "(not set — configure it in Settings → Agent)",
      usingApiKey: Boolean(s.openaiApiKey),
      endpoint: base ? `${base}/chat/completions` : "(base URL not set)",
      systemPromptAppend: OPENAI_SYSTEM_PROMPT,
      tools: OPENAI_TOOL_INFO,
      disallowedTools: [],
      sessionNote:
        `Conversation memory is a local message log under ${DATA_DIR}/oai-sessions, capped at ` +
        `${MAX_HISTORY_MESSAGES} messages — there is no provider-side session resume across ` +
        `restarts beyond that stored history.`,
      ...common,
    };
  }
  return {
    backend: "claude-agent-sdk",
    backendLabel: claudeBackend.label,
    backendDescription: claudeBackend.description,
    model: `${resolveModel(s.model)}${s.model ? "" : " (BlattBot default)"}`,
    modelAliases: MODEL_ALIASES,
    usingApiKey: Boolean(s.apiKey),
    endpoint: s.anthropicBaseUrl || "https://api.anthropic.com",
    anthropicBaseUrl: s.anthropicBaseUrl || "https://api.anthropic.com",
    systemPromptPreset: "claude_code",
    systemPromptAppend: SYSTEM_APPEND,
    tools: [...AGENT_TOOL_INFO, ASK_USER_TOOL_INFO],
    disallowedTools: DISALLOWED_TOOLS,
    ...common,
  };
});

// ---- Overleaf accounts -----------------------------------------------------

/** Projects per account, for the UI. */
function accountProjectCount(accountId: string): number {
  return listProjects().filter((p) => p.accountId === accountId).length;
}

app.get("/api/accounts", async () =>
  listAccounts().map((a) => ({ ...publicAccount(a), projectCount: accountProjectCount(a.id) })),
);

app.post<{ Body: { url?: string; cookie?: string } }>("/api/accounts", async (req, reply) => {
  const rawUrl = (req.body?.url ?? "").trim();
  const rawCookie = (req.body?.cookie ?? "").trim();
  if (!rawUrl || !rawCookie) return reply.code(400).send({ error: "url and cookie are required" });
  let base: string;
  try {
    base = await canonicalOrigin(rawUrl);
  } catch {
    return reply.code(400).send({ error: "not a valid URL" });
  }
  const cookie = normalizeCookie(rawCookie);
  if (!(await cookieWorks(base, cookie))) {
    return reply.code(422).send({ error: `${new URL(base).hostname} rejected the session — log in again.` });
  }
  const email = await new OverleafClient(base, cookie).userEmail();
  const account = upsertAccount({ baseUrl: base, cookie, email });
  return { ...publicAccount(account), projectCount: accountProjectCount(account.id) };
});

app.post<{ Params: { id: string }; Body: { mode?: "import" | "browser" } }>(
  "/api/accounts/:id/refresh",
  async (req, reply) => {
    const account = getAccount(req.params.id);
    if (!account) return reply.code(404).send({ error: "unknown account" });
    const mode = req.body?.mode ?? "import";
    try {
      if (mode === "import") {
        if (!(await refreshFromBrowsers(account))) {
          return reply.code(422).send({
            error: `No working session for ${new URL(account.baseUrl).hostname} in your browsers — log in there once, or use the browser login.`,
          });
        }
      } else {
        const found = await captureViaBrowser(account.baseUrl);
        const cookie = normalizeCookie(found.cookie);
        if (!(await cookieWorks(account.baseUrl, cookie))) {
          return reply.code(422).send({ error: "the captured session was rejected — try again" });
        }
        const email = await new OverleafClient(account.baseUrl, cookie).userEmail();
        updateAccount(account.id, {
          cookie,
          email: email ?? account.email,
          status: "connected",
          lastVerifiedAt: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      return reply.code(422).send({ error: err.message });
    }
    const fresh = getAccount(account.id)!;
    return { ...publicAccount(fresh), projectCount: accountProjectCount(fresh.id) };
  },
);

app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req, reply) => {
  const account = getAccount(req.params.id);
  if (!account) return reply.code(404).send({ error: "unknown account" });
  const used = listProjects().filter((p) => p.accountId === account.id);
  if (used.length > 0) {
    return reply.code(409).send({
      error: `${used.length} project(s) still use this account (${used.map((p) => p.name).join(", ")}) — remove them first.`,
    });
  }
  removeAccount(account.id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/accounts/:id/projects", async (req, reply) => {
  const account = getAccount(req.params.id);
  if (!account) return reply.code(404).send({ error: "unknown account" });
  const list = async () => new OverleafClient(account.baseUrl, getAccount(account.id)!.cookie).listProjects();
  try {
    return { baseUrl: account.baseUrl, projects: await list() };
  } catch (err: any) {
    if (err instanceof OverleafAuthError && (await refreshFromBrowsers(account))) {
      try {
        return { baseUrl: account.baseUrl, projects: await list() };
      } catch {
        /* fall through */
      }
    }
    if (err instanceof OverleafAuthError) {
      updateAccount(account.id, { status: "disconnected" });
      return reply.code(401).send({
        error: `The ${new URL(account.baseUrl).hostname} session has expired — reconnect the account.`,
      });
    }
    return reply.code(422).send({ error: err.message });
  }
});

app.get("/api/projects", async () => listProjects().map(publicProject));

/** Accept a pasted cookie in any common shape: bare value, name=value, full header, "Cookie:" prefix. */
function normalizeCookie(input: string): string {
  let c = input.trim().replace(/^cookie:\s*/i, "").replace(/;\s*$/, "");
  if (!c.includes("=")) c = `overleaf_session2=${c}`;
  return c;
}

/** Escape LaTeX-special characters so a project name is safe inside \title{…}. */
function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function localTemplate(name: string): { path: string; content: string }[] {
  return [
    {
      path: "main.tex",
      content: `\\documentclass{article}

\\title{${texEscape(name)}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}

Start writing here.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
    },
    {
      path: "references.bib",
      content: "% BibTeX entries live here — add them by hand or ask BlattBot to cite papers.\n",
    },
  ];
}

app.post<{
  Body: {
    name?: string;
    gitUrl?: string;
    url?: string;
    token?: string;
    cookie?: string;
    accountId?: string;
    projectId?: string;
    local?: boolean;
  };
}>(
  "/api/projects",
  async (req, reply) => {
    const body = req.body ?? ({} as any);
    const url = (body.url ?? body.gitUrl ?? "").trim();

    // ---- Local mode: standalone project, publishable to Overleaf later ----
    if (body.local) {
      const name = body.name?.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      const project = addProject({ name, gitUrl: "local", kind: "local" });
      try {
        const dir = projectDir(project.id);
        await git.initRepo(dir);
        for (const f of localTemplate(name)) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, f.path), f.content);
        }
        await git.commitAll(dir, "New project");
      } catch (err: any) {
        removeProject(project.id);
        rmSync(projectDir(project.id), { recursive: true, force: true });
        return reply.code(422).send({ error: `Project setup failed: ${err.message}` });
      }
      updateProject(project.id, { mainTex: "main.tex" });
      return publicProject(getProject(project.id)!);
    }

    // ---- Overleaf mode: via a stored account, or legacy pasted link + cookie ----
    let olRef = parseProjectUrl(url);
    let accountId: string | undefined;
    let cookie: string | undefined;
    if (body.accountId && body.projectId) {
      const account = getAccount(body.accountId);
      if (!account) return reply.code(404).send({ error: "unknown account" });
      if (!/^[0-9a-fA-F]{24}$/.test(body.projectId)) {
        return reply.code(400).send({ error: "invalid Overleaf project id" });
      }
      olRef = { baseUrl: account.baseUrl, projectId: body.projectId };
      accountId = account.id;
      cookie = account.cookie;
    } else if (olRef) {
      if (!body.cookie?.trim()) {
        return reply.code(400).send({
          error:
            "This looks like an Overleaf project link — paste your session cookie too (DevTools → Application → Cookies).",
        });
      }
      cookie = normalizeCookie(body.cookie);
      // Fold the pasted session into a persistent account.
      const email = await new OverleafClient(olRef.baseUrl, cookie).userEmail();
      accountId = upsertAccount({ baseUrl: olRef.baseUrl, cookie, email }).id;
    } else if (!url) {
      return reply.code(400).send({ error: "url is required" });
    }

    if (olRef && cookie) {
      const client = new OverleafClient(olRef.baseUrl, cookie);
      let snapshot: Map<string, Buffer>;
      try {
        snapshot = unpackZip(await client.downloadZip(olRef.projectId));
      } catch (err: any) {
        return reply.code(422).send({ error: `Overleaf sync failed: ${err.message}` });
      }
      const name =
        body.name?.trim() || (await client.projectName(olRef.projectId)) || `Overleaf ${olRef.projectId.slice(0, 6)}`;
      const project = addProject({
        name,
        gitUrl: `${olRef.baseUrl}/project/${olRef.projectId}`,
        kind: "overleaf",
        overleafBaseUrl: olRef.baseUrl,
        overleafProjectId: olRef.projectId,
        accountId,
      });
      try {
        const dir = projectDir(project.id);
        await git.initRepo(dir);
        await applySnapshot(dir, snapshot, "Initial sync from Overleaf");
      } catch (err: any) {
        removeProject(project.id);
        rmSync(projectDir(project.id), { recursive: true, force: true });
        return reply.code(422).send({ error: `Local mirror setup failed: ${err.message}` });
      }
      const mainTex = findMainTex(projectDir(project.id));
      if (mainTex) updateProject(project.id, { mainTex });
      return publicProject(getProject(project.id)!);
    }

    // ---- git mode (Overleaf git bridge, GitHub, local path, …) ----
    const name = body.name?.trim() || url.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "project";
    const project = addProject({ name, gitUrl: url, kind: "git", token: body.token });
    try {
      await git.clone(url, body.token, projectDir(project.id));
    } catch (err: any) {
      removeProject(project.id);
      rmSync(projectDir(project.id), { recursive: true, force: true });
      return reply.code(422).send({ error: `Clone failed: ${err.message}` });
    }
    const mainTex = findMainTex(projectDir(project.id));
    if (mainTex) updateProject(project.id, { mainTex });
    return publicProject(getProject(project.id)!);
  },
);

app.post<{ Body: { url?: string; cookie?: string } }>("/api/overleaf/projects", async (req, reply) => {
  const rawUrl = (req.body?.url ?? "").trim();
  const rawCookie = (req.body?.cookie ?? "").trim();
  if (!rawUrl) return reply.code(400).send({ error: "url is required" });
  if (!rawCookie) return reply.code(400).send({ error: "cookie is required" });
  let base: string;
  try {
    base = await canonicalOrigin(rawUrl);
  } catch {
    return reply.code(400).send({ error: "not a valid URL" });
  }
  const client = new OverleafClient(base, normalizeCookie(rawCookie));
  try {
    const projects = await client.listProjects();
    return { baseUrl: base, projects };
  } catch (err: any) {
    return reply.code(422).send({ error: err.message });
  }
});

app.post<{ Body: { url: string } }>("/api/cookies/import", async (req, reply) => {
  let base: string;
  try {
    base = await canonicalOrigin((req.body?.url ?? "").trim());
  } catch {
    return reply.code(400).send({ error: "url is required" });
  }
  const host = new URL(base).hostname;
  const candidates = importFromBrowsers(base);
  if (candidates.length === 0) {
    return reply.code(404).send({
      error: `No session cookie for ${host} found in any installed browser. Log in to Overleaf once, or use the browser login.`,
    });
  }
  // Return the first candidate the instance actually accepts.
  let sawExpired = false;
  for (const c of candidates) {
    if (await cookieWorks(base, c.cookie)) return { cookie: c.cookie, source: c.source };
    sawExpired = true;
  }
  return reply.code(422).send({
    error: sawExpired
      ? `Found a session in ${candidates.map((c) => c.source).join(", ")}, but ${host} rejected it — log in to Overleaf again there, then retry.`
      : `No usable session for ${host}.`,
  });
});

app.post<{ Body: { url: string } }>("/api/cookies/browser", async (req, reply) => {
  let base: string;
  try {
    base = await canonicalOrigin((req.body?.url ?? "").trim());
  } catch {
    return reply.code(400).send({ error: "url is required" });
  }
  try {
    const found = await captureViaBrowser(base);
    return { cookie: found.cookie, source: found.source };
  } catch (err: any) {
    return reply.code(422).send({ error: err.message });
  }
});

app.patch<{ Params: { id: string }; Body: { cookie?: string } }>("/api/projects/:id", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  if (req.body?.cookie?.trim()) {
    const cookie = normalizeCookie(req.body.cookie);
    // Sessions live on accounts now; fall back to the legacy per-project field.
    if (project.accountId && getAccount(project.accountId)) {
      updateAccount(project.accountId, {
        cookie,
        status: "connected",
        lastVerifiedAt: new Date().toISOString(),
      });
    } else {
      updateProject(project.id, { cookie });
    }
    return { ok: true };
  }
  return reply.code(400).send({ error: "nothing to update" });
});

app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
  const { id } = req.params;
  if (!getProject(id)) return reply.code(404).send({ error: "unknown project" });
  removeProject(id);
  rmSync(projectDir(id), { recursive: true, force: true });
  rmSync(buildDir(id), { recursive: true, force: true });
  rmSync(contextUploadsDir(id), { recursive: true, force: true });
  // The chat transcripts that referenced them are going too.
  deleteChatUploads(id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const dir = projectDir(project.id);
  const compile = lastCompile.get(project.id);
  return {
    ...publicProject(project),
    files: listFiles(dir),
    turnActive: isTurnActive(project.id),
    // A reload mid-turn restores the actionable question card from this.
    pendingQuestion: pendingQuestion(project.id) ?? null,
    hasChanges: await git.hasChanges(dir).catch(() => false),
    lastCompile: compile ? compilePublic(compile) : null,
  };
});

// ---- Per-project settings ---------------------------------------------------

/** The stored settings object plus the model a turn on this project actually
 *  runs under the ACTIVE backend (override → global, aliases resolved for
 *  claude, verbatim for openai). */
function projectSettingsView(project: Project) {
  return {
    ...(project.settings ?? {}),
    resolvedModel: resolveBackendModel(project, loadSettings()),
  };
}

app.get<{ Params: { id: string } }>("/api/projects/:id/settings", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  return projectSettingsView(project);
});

app.put<{
  Params: { id: string };
  Body: { styleAppend?: string; model?: string; defaultMode?: string };
}>("/api/projects/:id/settings", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  let patch: Partial<ProjectSettings>;
  try {
    patch = validateProjectSettingsPatch(req.body);
  } catch (err: any) {
    return reply.code(400).send({ error: err.message });
  }
  // updateProject merges top-level keys only — always write the WHOLE settings
  // object. An empty string clears its field (kept out of projects.json).
  const merged: ProjectSettings = { ...(project.settings ?? {}), ...patch };
  for (const key of Object.keys(merged) as (keyof ProjectSettings)[]) {
    if (!merged[key]?.trim()) delete merged[key];
  }
  const updated = updateProject(project.id, { settings: merged })!;
  return projectSettingsView(updated);
});

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

/** Per project, when the last orphan sweep ran (see sweepChatUploads). */
const lastUploadSweep = new Map<string, number>();
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Drop chat-image files no transcript references. Images are stored before the
 * message is posted, so every send that never completes (409 "turn in
 * progress", a closed tab, a rejected message, a failed sibling upload) leaves
 * one behind that nothing can reach. Runs opportunistically when a project's
 * chat list is fetched — that covers project open — and at most once every
 * SWEEP_INTERVAL_MS per project, so the transcript scan stays off the hot path.
 * Failures are swallowed: housekeeping must never break a request.
 */
function sweepChatUploads(projectId: string): void {
  const now = Date.now();
  const last = lastUploadSweep.get(projectId) ?? 0;
  if (now - last < SWEEP_INTERVAL_MS) return;
  lastUploadSweep.set(projectId, now);
  try {
    pruneOrphanChatUploads(projectId, referencedImageIds(projectId), now);
  } catch {
    /* never fatal */
  }
}

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

app.get<{ Params: { id: string } }>("/api/projects/:id/diff", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const diff = await git.workingDiff(projectDir(project.id));
  return { diff };
});

app.post<{ Params: { id: string } }>("/api/projects/:id/sync", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
  try {
    const result = await sync.syncIn(project);
    broadcast(project.id, {
      type: "synced",
      detail: result.detail,
      merged: result.merged,
      drift: result.drift,
    });
    return {
      ok: true,
      output: result.detail ?? "",
      changed: result.changed ?? false,
      merged: result.merged ?? [],
      drift: result.drift ?? [],
    };
  } catch (err: any) {
    return reply.code(422).send({ error: err.message });
  }
});

app.post<{ Params: { id: string }; Body: { accountId?: string } }>(
  "/api/projects/:id/publish",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (project.kind !== "local") {
      return reply.code(400).send({ error: "only local projects can be published to Overleaf" });
    }
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const account = getAccount(req.body?.accountId ?? "");
    if (!account) return reply.code(404).send({ error: "unknown account" });
    try {
      const result = await sync.publishLocal(project, account);
      broadcast(project.id, {
        type: "published",
        project: publicProject(result.project),
        uploaded: result.uploaded,
        warnings: result.warnings,
      });
      return {
        project: publicProject(result.project),
        uploaded: result.uploaded,
        warnings: result.warnings,
      };
    } catch (err: any) {
      if (err instanceof OverleafAuthError) {
        updateAccount(account.id, { status: "disconnected" });
        return reply.code(401).send({
          error: `The ${new URL(account.baseUrl).hostname} session has expired — reconnect the account.`,
        });
      }
      return reply.code(422).send({ error: `Publish failed: ${err.message}` });
    }
  },
);

app.post<{ Params: { id: string }; Body: { message?: string; force?: boolean } }>(
  "/api/projects/:id/approve",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const message = req.body?.message?.trim() || "BlattBot edit";
    try {
      const result = await sync.approve(project, message, { force: req.body?.force === true });
      broadcast(project.id, {
        type: "approved",
        pushed: result.pushed,
        uploaded: result.uploaded,
        deleted: result.deleted,
        warnings: result.warnings,
        absorbedRemote: result.absorbedRemote,
      });
      return { ok: true, ...result };
    } catch (err: any) {
      // Remote drift touching locally edited files: nothing was committed or
      // pushed — the UI offers per-file discard or an explicit force.
      if (err instanceof sync.ApproveConflictError) {
        return reply.code(409).send({ error: err.message, conflicts: err.conflicts });
      }
      return reply.code(422).send({ error: err.message });
    }
  },
);

app.post<{ Params: { id: string } }>("/api/projects/:id/reject", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
  await git.discard(projectDir(project.id));
  broadcast(project.id, { type: "rejected" });
  return { ok: true };
});

/** Paths of the files appearing in a unified working diff. */
function diffPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
    }
  }
  return paths;
}

app.post<{ Params: { id: string }; Body: { path?: string } }>(
  "/api/projects/:id/reject-file",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const rel = (req.body?.path ?? "").trim();
    if (!rel) return reply.code(400).send({ error: "path is required" });
    const dir = projectDir(project.id);
    const abs = resolve(dir, rel);
    if (abs === dir || !abs.startsWith(dir + sep)) {
      return reply.code(400).send({ error: "invalid path" });
    }
    const current = await git.workingDiff(dir);
    if (!diffPaths(current).has(rel)) {
      return reply.code(409).send({ error: "that file has no pending changes — refresh the proof" });
    }
    await git.discardPath(dir, rel);
    const diff = await git.workingDiff(dir);
    broadcast(project.id, { type: "diff", diff });
    return { ok: true, diff };
  },
);

app.post<{ Params: { id: string }; Body: { patch?: string } }>(
  "/api/projects/:id/reject-hunk",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const patch = req.body?.patch ?? "";
    if (!patch.trim()) return reply.code(400).send({ error: "patch is required" });
    const dir = projectDir(project.id);
    try {
      await git.applyReverse(dir, patch);
    } catch {
      return reply.code(409).send({ error: "hunk no longer applies — refresh the proof" });
    }
    const diff = await git.workingDiff(dir);
    broadcast(project.id, { type: "diff", diff });
    return { ok: true, diff };
  },
);

app.post<{ Params: { id: string } }>("/api/projects/:id/compile", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  broadcast(project.id, { type: "compile_start" });
  const result = await compileProject(project.id, projectDir(project.id), project.mainTex);
  lastCompile.set(project.id, result);
  broadcast(project.id, { type: "compile", ...compilePublic(result) });
  return compilePublic(result);
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
    const compile = lastCompile.get(project.id);
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

const MAX_TEXT_FILE = 2 * 1024 * 1024;

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

app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
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
    writeFileSync(abs, content);
    const diff = await git.workingDiff(dir).catch(() => "");
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

// ---- References: Zotero-lite citation manager ------------------------------

/** Best source link for a bib entry: DOI → arXiv abstract page → url field. */
function refLink(entry: BibEntry): string | null {
  const doi = entry.fields.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) return `https://doi.org/${doi}`;
  const arxivId = arxivIdFromEntry(entry);
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
  if (entry.fields.url?.trim()) return entry.fields.url.trim();
  return null;
}

app.get<{ Params: { id: string } }>("/api/projects/:id/refs", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const dir = projectDir(project.id);
  const all = readAllBibEntries(dir);
  const usage = collectCiteUsage(dir);
  const store = readPaperStore(project.id);
  const { unusedKeys, undefinedKeys } = usageReport(all.map((x) => x.entry.key), usage);
  const entries = all.map(({ file, entry }) => {
    const rec = store[entry.key];
    return {
      file,
      key: entry.key,
      type: entry.type,
      title: entry.fields.title ?? null,
      author: entry.fields.author ?? null,
      year: entry.fields.year ?? null,
      doi: entry.fields.doi ?? null,
      link: refLink(entry),
      usage: usage[entry.key] ?? [],
      raw: entry.raw,
      summary: rec?.summary,
      summarySource: rec?.source,
      hasPdf: Boolean(paperPdfPath(project.id, entry.key, store)),
    };
  });
  return {
    entries,
    undefinedKeys,
    unusedCount: unusedKeys.length,
    audit: readAudit(project.id),
    claimAudit: readClaimAudit(project.id),
  };
});

// Deterministic citation audit: every entry checked against Crossref/OpenAlex
// (no LLM). The result is persisted so the badges survive reloads.
app.post<{ Params: { id: string } }>("/api/projects/:id/refs/audit", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  try {
    return await auditCitations(project.id, projectDir(project.id));
  } catch (err: any) {
    return reply.code(422).send({ error: err?.message ?? String(err) });
  }
});

// Project-wide claim check: every cited entry against the text at its first
// \cite site (verify_citation_support run in bulk). Unlike the deterministic
// audit above this reads each paper and calls an LLM, so it is slow for a
// large bibliography — the result is persisted so the report survives reloads.
app.post<{ Params: { id: string } }>("/api/projects/:id/refs/verify-all", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  try {
    return await verifyAllCitations(project.id, projectDir(project.id));
  } catch (err: any) {
    return reply.code(422).send({ error: err?.message ?? String(err) });
  }
});

// The audit's checks are heuristic — accepting an entry records the user's
// judgement that a flagged reference is sound (until the entry itself changes).
app.post<{ Params: { id: string }; Body: { key?: string } }>(
  "/api/projects/:id/refs/audit/accept",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!key) return reply.code(400).send({ error: "key is required" });
    try {
      const result = acceptAuditEntry(project.id, projectDir(project.id), key);
      return { key, result, audit: readAudit(project.id) };
    } catch (err: any) {
      return reply.code(404).send({ error: err?.message ?? String(err) });
    }
  },
);

// Manual reference edits are ordinary working-tree changes: every write below
// recomputes the working diff and broadcasts it so the Proof view stays live.

app.post<{ Params: { id: string }; Body: { bibtex?: string; bibFile?: string } }>(
  "/api/projects/:id/refs",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const bibtex = req.body?.bibtex ?? "";
    if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
    const dir = projectDir(project.id);
    const bibFile = req.body?.bibFile?.trim() || undefined;
    if (bibFile) {
      const abs = resolve(dir, bibFile);
      if (abs === dir || !abs.startsWith(dir + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }
    }
    try {
      const result = addRefEntry(dir, bibtex, bibFile);
      const diff = await git.workingDiff(dir);
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, key: result.key, diff };
    } catch (err: any) {
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.put<{ Params: { id: string; key: string }; Body: { bibtex?: string } }>(
  "/api/projects/:id/refs/:key",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const bibtex = req.body?.bibtex ?? "";
    if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
    const dir = projectDir(project.id);
    try {
      const result = updateRefEntry(dir, req.params.key, bibtex);
      const diff = await git.workingDiff(dir);
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, key: result.key, diff };
    } catch (err: any) {
      if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.delete<{ Params: { id: string; key: string } }>(
  "/api/projects/:id/refs/:key",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const dir = projectDir(project.id);
    try {
      deleteRefEntry(dir, req.params.key);
      const diff = await git.workingDiff(dir);
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, diff };
    } catch (err: any) {
      if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.post<{ Params: { id: string; key: string }; Body: { force?: boolean } }>(
  "/api/projects/:id/refs/:key/tldr",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    try {
      return await getTldr(project.id, projectDir(project.id), req.params.key, {
        force: Boolean(req.body?.force),
      });
    } catch (err: any) {
      if (err instanceof RateLimitError) return reply.code(429).send({ error: err.message });
      if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.post<{ Params: { id: string; key: string } }>("/api/projects/:id/refs/:key/pdf", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  try {
    await ensurePaperPdf(project.id, projectDir(project.id), req.params.key);
    return { ok: true };
  } catch (err: any) {
    if (err instanceof NoPdfError) return reply.code(404).send({ error: err.message });
    if (err instanceof RateLimitError) return reply.code(429).send({ error: err.message });
    if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
    return reply.code(422).send({ error: err?.message ?? String(err) });
  }
});

app.get<{ Params: { id: string; key: string } }>("/api/projects/:id/refs/:key/pdf", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const path = paperPdfPath(project.id, req.params.key);
  if (!path) return reply.code(404).send({ error: "no cached PDF — fetch it first" });
  reply.header("Cache-Control", "no-store");
  reply.header("Content-Disposition", `inline; filename="${sanitizeKeyForFile(req.params.key)}.pdf"`);
  return reply.type("application/pdf").send(createReadStream(path));
});

/** Manual, on-demand version of the agent's verify_citation_support tool — not persisted. */
app.post<{ Params: { id: string; key: string }; Body: { claim?: string } }>(
  "/api/projects/:id/refs/:key/verify",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const claim = req.body?.claim?.trim() ?? "";
    if (!claim) return reply.code(400).send({ error: "claim is required" });
    try {
      return await verifyCitationSupport(project.id, projectDir(project.id), req.params.key, claim);
    } catch (err: any) {
      if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.post<{ Params: { id: string }; Body: { bibtex?: string; bibFile?: string } }>(
  "/api/projects/:id/bib/import",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const bibtex = req.body?.bibtex ?? "";
    if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
    try {
      return importBibtex(projectDir(project.id), bibtex, req.body?.bibFile?.trim() || undefined);
    } catch (err: any) {
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  },
);

app.get<{ Params: { id: string } }>("/api/projects/:id/bib/export", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const text = exportBibliography(projectDir(project.id));
  if (!text) return reply.code(404).send({ error: "no .bib entries in this project" });
  reply.header("Content-Disposition", `attachment; filename="references.bib"`);
  return reply.type("text/x-bibtex").send(text);
});

app.get<{ Params: { id: string } }>("/api/projects/:id/log", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const log = await git.log(projectDir(project.id)).catch(() => "");
  return { log };
});

// ---- Chats: persistent per-project conversations ---------------------------

app.get<{ Params: { id: string } }>("/api/projects/:id/chats", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const active = ensureActiveChat(project.id);
  // Project open (and every chat-list refresh) is the cheap, natural moment to
  // collect uploads whose send never happened.
  sweepChatUploads(project.id);
  return { chats: listChats(project.id).map(publicChat), activeChatId: active.id };
});

app.post<{ Params: { id: string } }>("/api/projects/:id/chats", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  // Creating also activates — same hazard as /activate while a turn streams.
  if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
  const chat = createChat(project.id);
  updateProject(project.id, { activeChatId: chat.id });
  return publicChat(chat);
});

app.post<{ Params: { id: string; chatId: string } }>(
  "/api/projects/:id/chats/:chatId/activate",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const chat = setActiveChat(project.id, req.params.chatId);
    if (!chat) return reply.code(404).send({ error: "unknown chat" });
    return { ok: true, activeChatId: chat.id };
  },
);

app.get<{ Params: { id: string; chatId: string } }>(
  "/api/projects/:id/chats/:chatId/transcript",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (!getChat(project.id, req.params.chatId)) return reply.code(404).send({ error: "unknown chat" });
    return { events: readTranscript(project.id, req.params.chatId) };
  },
);

app.delete<{ Params: { id: string; chatId: string } }>(
  "/api/projects/:id/chats/:chatId",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    if (!deleteChat(project.id, req.params.chatId)) return reply.code(404).send({ error: "unknown chat" });
    // If the active chat went away this reactivates the newest remaining
    // conversation, or creates a fresh one when none is left.
    const active = ensureActiveChat(project.id);
    return { ok: true, chats: listChats(project.id).map(publicChat), activeChatId: active.id };
  },
);

// AI-use disclosure: deterministic facts from the stored chats, composed into
// a factual paragraph; the agent may polish the phrasing, but any failure
// falls back to the deterministic text — the endpoint itself never fails on it.
app.post<{ Params: { id: string } }>("/api/projects/:id/disclosure", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const facts = collectDisclosureFacts(project.id);
  let text = composeDisclosure(project.name, facts);
  if (facts.turns > 0) {
    try {
      const polished = await runOneShot(
        "Polish the phrasing of this AI-use disclosure statement for an academic paper. " +
          "Keep every fact, number, and name exactly as stated, keep it to one short factual " +
          "paragraph, and use no puffery. Reply with only the revised paragraph.\n\n" +
          text,
      );
      if (polished.trim()) text = polished.trim();
    } catch {
      /* the deterministic paragraph stands */
    }
  }
  return { text, facts };
});

app.post<{
  Params: { id: string };
  Body: { message: string; mode?: string; files?: string[]; images?: string[] };
}>(
  "/api/projects/:id/chat",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const message = req.body?.message?.trim() ?? "";
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn already in progress" });
    // Attached images: ids from POST …/chat-image, resolved back to the files
    // stored outside the working tree.
    let attachments: TurnAttachment[];
    try {
      attachments = resolveAttachments(project.id, req.body?.images);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    // "Here's a screenshot" with no words is the most natural way to use a
    // paste-an-image composer, so pictures alone are a complete message; the
    // attachment note the prompt carries tells the agent what it is looking at.
    if (!message && attachments.length === 0) {
      return reply.code(400).send({ error: "message is required" });
    }
    const mode: AgentMode = AGENT_MODES.some((m) => m.id === req.body?.mode)
      ? (req.body!.mode as AgentMode)
      : "edit";
    let scope: string[] | undefined;
    if (req.body?.files !== undefined) {
      try {
        const validated = validateScope(projectDir(project.id), req.body.files);
        if (validated.length > 0) scope = validated;
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    }

    // The message goes to the project's active chat; the turn resumes that
    // chat's own session and every UI-relevant event is persisted to it.
    const activeChat = ensureActiveChat(project.id);
    const chatId = activeChat.id;
    try {
      appendEvent(project.id, chatId, {
        type: "user_message",
        text: message,
        mode,
        ...(scope ? { scope } : {}),
        // id + mime is all the restored transcript needs to render a thumbnail.
        ...(attachments.length > 0
          ? { attachments: attachments.map((a) => ({ id: a.id, mime: a.mime })) }
          : {}),
      });
    } catch {
      /* persistence must never block the turn */
    }
    /** Durable subset of the stream — deltas are skipped; text_final has the full text. */
    const persist = (event: Record<string, unknown>) => {
      try {
        const t = event.type;
        if (
          t === "text_final" ||
          t === "tool_use" ||
          t === "tool_result" ||
          t === "turn_end" ||
          t === "notice" ||
          t === "question" ||
          t === "question_answered" ||
          t === "question_dismissed"
        ) {
          appendEvent(project.id, chatId, event as { type: string });
        } else if (t === "error") {
          appendEvent(project.id, chatId, {
            type: "notice",
            tone: "error",
            text: String(event.message ?? "agent error"),
          });
        }
      } catch {
        /* best effort */
      }
    };

    // Run the turn in the background; progress streams over the websocket.
    // isTurnActive (the 409 guards, the polled turnActive field) must stay
    // true for this whole pipeline, not just the backend call inside runTurn —
    // otherwise a second /chat can start while the diff/recompile tail below
    // is still touching the same working tree.
    beginTurnPipeline(project.id);
    void (async () => {
      try {
        broadcast(project.id, { type: "turn_start" });
        // Pick up collaborator edits before the agent touches anything.
        try {
          const result = await sync.syncIn(project);
          if (result.detail) {
            broadcast(project.id, { type: "sync_warning", message: result.detail });
            persist({ type: "notice", tone: "warn", text: `Sync: ${result.detail}` });
          }
        } catch (err: any) {
          broadcast(project.id, { type: "sync_warning", message: err.message });
          persist({ type: "notice", tone: "warn", text: `Sync: ${err.message}` });
        }
        // Wrap the sink so edits stream a live diff and per-edit file diffs mid-turn;
        // persistence taps the enriched events (tool_result carries its fileDiff).
        const turnSink = makeTurnEventSink(projectDir(project.id), (event) => {
          broadcast(project.id, event);
          if (!event.live) persist(event);
        });
        await runTurn(
          project,
          message,
          turnSink.sink,
          mode,
          scope,
          {
            sessionId: activeChat.sessionId,
            onSessionId: (sessionId) => {
              try {
                updateChat(project.id, chatId, { sessionId });
              } catch {
                /* best effort */
              }
            },
          },
          attachments,
        );
        // No live-diff timer may fire past this point; the broadcast below is authoritative.
        await turnSink.close();
        let turnDiff = "";
        try {
          turnDiff = await git.workingDiff(projectDir(project.id));
          broadcast(project.id, { type: "diff", diff: turnDiff });
        } catch (err: any) {
          broadcast(project.id, { type: "error", message: `diff failed: ${err.message}` });
        }
        // Refresh the PDF preview — but only when the turn actually changed
        // something; a purely conversational message needs no recompile.
        if (turnDiff.trim()) {
          broadcast(project.id, { type: "compile_start" });
          const result = await compileProject(project.id, projectDir(project.id), project.mainTex);
          lastCompile.set(project.id, result);
          broadcast(project.id, { type: "compile", ...compilePublic(result) });
        }
      } finally {
        endTurnPipeline(project.id);
      }
    })();

    return { ok: true };
  },
);

app.post<{ Params: { id: string } }>("/api/projects/:id/interrupt", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const interrupted = interruptTurn(project.id);
  return { ok: true, interrupted };
});

// ---- Mid-turn questions (AskUserQuestion / ask_user) -----------------------
// Answer the pending question: body maps each question's TEXT to the chosen
// answer string (multi-select answers comma-joined; free-text is any string).
app.post<{ Params: { id: string; questionId: string }; Body: { answers?: Record<string, string> } }>(
  "/api/projects/:id/question/:questionId",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    // The answers validate AGAINST the pending question (keys must be its
    // question texts) — resolve the id's status first so an unknown or
    // already-settled id still gets its 404/410 regardless of the body.
    const pending = pendingQuestion(project.id);
    if (!pending || pending.questionId !== req.params.questionId) {
      if (questionStatus(project.id, req.params.questionId) === "resolved") {
        return reply.code(410).send({ error: "that question was already answered or dismissed" });
      }
      return reply.code(404).send({ error: "no such pending question" });
    }
    let answers: Record<string, string>;
    try {
      answers = validateAnswers(req.body?.answers, pending.questions);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    const outcome = answerQuestion(project.id, req.params.questionId, answers);
    if (outcome === "unknown") return reply.code(404).send({ error: "no such pending question" });
    if (outcome === "resolved") {
      return reply.code(410).send({ error: "that question was already answered or dismissed" });
    }
    return { ok: true };
  },
);

app.post<{ Params: { id: string; questionId: string } }>(
  "/api/projects/:id/question/:questionId/dismiss",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const outcome = dismissQuestion(project.id, req.params.questionId);
    if (outcome === "unknown") return reply.code(404).send({ error: "no such pending question" });
    if (outcome === "resolved") {
      return reply.code(410).send({ error: "that question was already answered or dismissed" });
    }
    return { ok: true };
  },
);

app.get("/api/ws", { websocket: true }, (socket, req) => {
  // The upgrade bypasses the /api token hook — enforce it here. The browser
  // sends the SameSite cookie automatically; scripts may pass ?token=.
  const url = new URL(req.url ?? "", "http://localhost");
  if (
    !requestAuthorized(req.headers) &&
    url.searchParams.get("token") !== getAuthToken()
  ) {
    socket.close(4001, "unauthorized");
    return;
  }
  const projectId = url.searchParams.get("project");
  if (!projectId) {
    socket.close(4000, "project query param required");
    return;
  }
  subscribe(projectId, socket as any);
  socket.send(JSON.stringify({ type: "hello", projectId }));
});

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`BlattBot server listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Warm the update check in the background — never blocks startup, never throws.
void checkLatestVersion().catch(() => {});

// The CLI (bin/blattbot.js) imports this module to start the server and uses
// the app handle for a clean shutdown on Ctrl+C.
export { app };
