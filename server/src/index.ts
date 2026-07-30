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
} from "./config.js";
import * as git from "./git.js";
import { compileProject, detectEngine, type CompileResult } from "./compile.js";
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
  ensurePaperPdf,
  getTldr,
  paperPdfPath,
  readPaperStore,
  sanitizeKeyForFile,
} from "./papers.js";
import type { BibEntry } from "./bib.js";
import {
  AGENT_MODES,
  AGENT_TOOL_INFO,
  DISALLOWED_TOOLS,
  MODEL_ALIASES,
  SYSTEM_APPEND,
  interruptTurn,
  isTurnActive,
  resolveModel,
  runTurn,
  validateScope,
  type AgentMode,
} from "./agent.js";
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
  contextUploadsDir,
  deleteUpload,
  listContext,
  saveUpload,
  uploadPath,
  validateLinkPath,
} from "./context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BLATTBOT_PORT ?? 4560);

ensureDirs();
migrateProjectCookies();
const AUTH_TOKEN = getAuthToken();

// bodyLimit covers base64-encoded context uploads (25 MB file ≈ 34 MB JSON).
const app = Fastify({ logger: { level: "warn" }, bodyLimit: 40 * 1024 * 1024 });
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
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.type("text/html").send(createReadStream(join(webDist, "index.html")));
    }
  });
}

const lastCompile = new Map<string, CompileResult>();

function compilePublic(r: CompileResult) {
  const { pdfPath, ...rest } = r;
  return { ...rest, hasPdf: Boolean(pdfPath) };
}

app.get("/api/health", async () => {
  const engine = await detectEngine(loadSettings().engine || undefined);
  return { ok: true, engine: engine?.name ?? null };
});

// ---- Settings & transparency ----------------------------------------------

// resolvedModel: what the agent will actually run ("" and aliases resolved).
app.get("/api/settings", async () => {
  const s = loadSettings();
  return { ...publicSettings(s), resolvedModel: resolveModel(s.model) };
});

app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
  const s = saveSettings(req.body ?? {});
  return { ...publicSettings(s), resolvedModel: resolveModel(s.model) };
});

app.get("/api/agent/info", async () => {
  const s = loadSettings();
  return {
    backend: "claude-agent-sdk",
    backendDescription:
      "Claude Agent SDK running locally — reuses your Claude Code CLI login unless an API key is set.",
    model: `${resolveModel(s.model)}${s.model ? "" : " (BlattBot default)"}`,
    modelAliases: MODEL_ALIASES,
    usingApiKey: Boolean(s.apiKey),
    anthropicBaseUrl: s.anthropicBaseUrl || "https://api.anthropic.com",
    systemPromptPreset: "claude_code",
    systemPromptAppend: SYSTEM_APPEND,
    userSystemPromptAppend: s.systemPromptAppend,
    tools: AGENT_TOOL_INFO,
    modes: AGENT_MODES,
    disallowedTools: DISALLOWED_TOOLS,
    dataDir: DATA_DIR,
    projectsDir: PROJECTS_DIR,
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
    hasChanges: await git.hasChanges(dir).catch(() => false),
    lastCompile: compile ? compilePublic(compile) : null,
  };
});

// ---- External read-only context (code, data, literature) -------------------

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

app.get<{ Params: { id: string } }>("/api/projects/:id/diff", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const diff = await git.workingDiff(projectDir(project.id));
  return { diff };
});

app.post<{ Params: { id: string } }>("/api/projects/:id/sync", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  try {
    const result = await sync.syncIn(project);
    broadcast(project.id, { type: "synced", detail: result.detail });
    return { ok: true, output: result.detail ?? "" };
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

app.post<{ Params: { id: string }; Body: { message?: string } }>(
  "/api/projects/:id/approve",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const message = req.body?.message?.trim() || "BlattBot edit";
    try {
      const result = await sync.approve(project, message);
      broadcast(project.id, {
        type: "approved",
        pushed: result.pushed,
        uploaded: result.uploaded,
        deleted: result.deleted,
        warnings: result.warnings,
      });
      return { ok: true, ...result };
    } catch (err: any) {
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

app.get<{ Params: { id: string } }>("/api/projects/:id/pdf", async (req, reply) => {
  const project = getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "unknown project" });
  const compile = lastCompile.get(project.id);
  if (!compile?.pdfPath || !existsSync(compile.pdfPath)) {
    return reply.code(404).send({ error: "no compiled PDF — run compile first" });
  }
  reply.header("Cache-Control", "no-store");
  const filename = `${project.name.replace(/[^\w. -]+/g, "_") || "project"}.pdf`;
  reply.header("Content-Disposition", `inline; filename="${filename}"`);
  return reply.type("application/pdf").send(createReadStream(compile.pdfPath));
});

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

/** Best link for a bib entry: DOI → url field → arXiv abstract page. */
function refLink(entry: BibEntry): string | null {
  const doi = entry.fields.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) return `https://doi.org/${doi}`;
  if (entry.fields.url?.trim()) return entry.fields.url.trim();
  const arxivId = arxivIdFromEntry(entry);
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
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
  return { entries, undefinedKeys, unusedCount: unusedKeys.length };
});

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

app.post<{ Params: { id: string }; Body: { message: string; mode?: string; files?: string[] } }>(
  "/api/projects/:id/chat",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const message = req.body?.message?.trim();
    if (!message) return reply.code(400).send({ error: "message is required" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn already in progress" });
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
      });
    } catch {
      /* persistence must never block the turn */
    }
    /** Durable subset of the stream — deltas are skipped; text_final has the full text. */
    const persist = (event: Record<string, unknown>) => {
      try {
        const t = event.type;
        if (t === "text_final" || t === "tool_use" || t === "tool_result" || t === "turn_end" || t === "notice") {
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
    void (async () => {
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
      await runTurn(project, message, turnSink.sink, mode, scope, {
        sessionId: activeChat.sessionId,
        onSessionId: (sessionId) => {
          try {
            updateChat(project.id, chatId, { sessionId });
          } catch {
            /* best effort */
          }
        },
      });
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

// The CLI (bin/blattbot.js) imports this module to start the server and uses
// the app handle for a clean shutdown on Ctrl+C.
export { app };
