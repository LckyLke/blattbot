// BlattBot server entry: creates the Fastify app, installs the local-API
// security hooks, registers the route modules (routes/*.ts and the feature
// modules that register their own routes), serves the built web UI, listens.
import { registerInlineQuestions, isInlineQuestionActive } from "./inline-questions.js";
import { researchJobs, listResearchJobs } from "./research/jobs.js";
import { registerDeployment } from "./deployment.js";
import { registerPublisherAccess } from "./publisher-access.js";
import { registerClaudeSdkRoutes } from "./claude-sdk.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, getProject, listProjects, projectDir } from "./config.js";
import * as git from "./git.js";
import { isTurnActive } from "./agent.js";
import { checkLatestVersion } from "./version.js";
import { broadcast } from "./events.js";
import { GraphIndexer } from "./research/graph-indexer.js";
import { registerResearchRoutes } from "./research/routes.js";
import * as sync from "./sync.js";
import { migrateProjectCookies } from "./accounts.js";
import { getAuthToken, hostAllowed, requestAuthorized } from "./auth.js";
import { listenOrExit } from "./listen.js";
import { IMAGE_MIMES, MAX_IMAGE_BYTES } from "./chatimages.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerConflictRoutes } from "./routes/conflicts.js";
import { registerCompileRoutes } from "./routes/compile.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerFileOpRoutes } from "./routes/file-ops.js";
import { registerRefRoutes } from "./routes/refs.js";
import { registerChatRoutes } from "./routes/chats.js";
import { registerWsRoutes } from "./routes/ws.js";
import { registerOverleafReviewRoutes } from "./routes/overleaf-review.js";
import { registerSharedInstructionsRoutes } from "./routes/shared-instructions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BLATTBOT_PORT ?? 4560);

ensureDirs();
migrateProjectCookies();
// Before any agent turn can run: no git-bridge token may stay in a .git/config.
for (const project of listProjects()) {
  void sync.moveRemoteCredentials(project).catch(() => {
    /* retried before this project's next pull or push */
  });
}
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

registerDeployment(app, () => listProjects().some((p) =>
  isInlineQuestionActive(p.id) ||
  isTurnActive(p.id) || listResearchJobs(p.id).some((j) => ["queued", "running"].includes(j.state)),
));
const graphIndexer = new GraphIndexer();
// Called with the project lock already held (see research/routes.ts).
registerResearchRoutes(app, async (id) => {
  const diff = await git.workingDiff(projectDir(id));
  broadcast(id, { type: "diff", diff });
}, graphIndexer);
registerPublisherAccess(app);
registerClaudeSdkRoutes(app);
app.addHook("onClose", async () => { await Promise.all([graphIndexer.stop(), researchJobs.stop()]); });
app.addHook("onResponse", (req, reply, done) => {
  const id = (req.params as { id?: string })?.id;
  // Opening a project or completing a mutation schedules any changed entries.
  // The background scan also catches edits made outside the app.
  if (reply.statusCode < 400 && id && getProject(id) && !req.url.includes("/research") &&
      (req.method !== "GET" || /^\/api\/projects\/[^/?]+(?:\?|$)/.test(req.url))) {
    try { graphIndexer.request(id, projectDir(id)); } catch { /* background scan retries */ }
  }
  done();
});

// API routes, one module per area. All hooks above are installed first; the
// static UI and its not-found fallback below come last.
registerSystemRoutes(app, AUTH_TOKEN);
registerAccountRoutes(app);
registerProjectRoutes(app);
registerContextRoutes(app);
registerReviewRoutes(app);
registerHistoryRoutes(app);
registerConflictRoutes(app);
registerCompileRoutes(app);
registerFileRoutes(app);
registerFileOpRoutes(app);
registerRefRoutes(app);
registerChatRoutes(app);
registerInlineQuestions(app);
registerOverleafReviewRoutes(app);
registerSharedInstructionsRoutes(app);
registerWsRoutes(app);

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

// A busy port gets a clear message (or opens the BlattBot already on it).
await listenOrExit(app, PORT, AUTH_TOKEN);
console.log(`BlattBot server listening on http://127.0.0.1:${PORT}`);

graphIndexer.start();
researchJobs.start();

// Warm the update check in the background — never blocks startup, never throws.
void checkLatestVersion().catch(() => {});

// The CLI (bin/blattbot.js) imports this module to start the server and uses
// the app handle for a clean shutdown on Ctrl+C.
export { app };
