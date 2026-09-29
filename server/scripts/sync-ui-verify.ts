/** Project-entry sync, expiry notices, recovery, conflicts and navigation races. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMockOverleaf } from "./mock-overleaf.js";

const root = mkdtempSync(join(tmpdir(), "blattbot-sync-ui-"));
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const config = await import("../src/config.js");
const accounts = await import("../src/accounts.js");
const git = await import("../src/git.js");
config.ensureDirs();
const remoteId = "aaaa1111bbbb2222cccc3333";
const mock = await startMockOverleaf(4598, remoteId);
const account = accounts.upsertAccount({ baseUrl: "http://127.0.0.1:4598", cookie: "overleaf_session2=mock-session" });
const project = config.addProject({ name: "Sync test paper", kind: "overleaf", gitUrl: "", accountId: account.id, overleafBaseUrl: account.baseUrl, overleafProjectId: remoteId, mainTex: "main.tex" });
const local = config.addProject({ name: "Local notes", kind: "local", gitUrl: "", mainTex: "main.tex" });
const original = "\\documentclass{article}\n\\begin{document}\nOriginal.\n\\end{document}\n";
for (const p of [project, local]) {
  const dir = config.projectDir(p.id);
  mkdirSync(dir, { recursive: true });
  await git.initRepo(dir);
  writeFileSync(join(dir, "main.tex"), original);
  await git.commitAll(dir, "Initial fixture");
}
const main = join(config.projectDir(project.id), "main.tex");
const remote = original.replace("Original.", "Incoming collaborator edit.");
mock.files.set("main.tex", Buffer.from(remote));
const base = "http://127.0.0.1:4597";
let logs = "";
function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    env: { ...process.env, BLATTBOT_PORT: "4597" }, stdio: "pipe",
  });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  return child;
}
let server = startServer();
async function ready() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/bootstrap")).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(logs);
}
async function stopServer() {
  const stopped = new Promise(resolve => server.once("exit", resolve));
  server.kill("SIGTERM");
  await stopped;
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await ready();
  browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { void dialog.accept(); });
  await page.addInitScript(({ id }) => {
    if (!localStorage.getItem("blattbot.selectedProject")) {
      localStorage.setItem("blattbot.selectedProject", id);
      localStorage.setItem("blattbot.view", "project");
      localStorage.setItem("blattbot.paneLeft.v2", "chat");
      localStorage.setItem("blattbot.paneRight.v2", "source");
    }
  }, { id: project.id });
  let syncCount = 0;
  let localSyncCount = 0;
  page.on("request", request => {
    if (request.url() === `${base}/api/projects/${project.id}/sync`) syncCount++;
    if (request.url() === `${base}/api/projects/${local.id}/sync`) localSyncCount++;
  });
  const syncResponse = () => page.waitForResponse(response => response.url() === `${base}/api/projects/${project.id}/sync`);
  const warning = page.getByRole("alert", { name: "Project sync warning" });
  const popup = page.getByRole("dialog");
  const firstSync = syncResponse();
  await page.goto(base);
  assert((await firstSync).ok());
  await page.getByRole("navigation", { name: "Project sidebar" }).waitFor();
  assert.equal(readFileSync(main, "utf8"), remote, "opening pulls incoming edits");
  assert.equal(syncCount, 1, "one initial sync");
  await warning.waitFor({ state: "hidden" });

  const restoredSync = syncResponse();
  await page.reload();
  assert((await restoredSync).ok());
  assert.equal(syncCount, 2, "restored project syncs on reload");

  // Expiry is detected without pressing Sync or leaving the project.
  mock.authOk = false;
  await page.clock.fastForward(60_001);
  await popup.getByRole("heading", { name: "Overleaf session expired" }).waitFor();
  await page.screenshot({ path: "/tmp/blattbot-session-expired.png" });
  await popup.getByRole("button", { name: "Keep working locally" }).click();
  await warning.waitFor();
  const checked = page.waitForResponse(response => response.url().endsWith(`/api/accounts/${account.id}/projects`));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await checked;
  await popup.waitFor({ state: "hidden" });
  assert.equal(syncCount, 2, "session checks do not pull project files");

  // The browser capture itself is external; stub it while exercising the
  // reconnect button, subsequent real sync and dismissal of both notices.
  mock.authOk = true;
  await page.route(`**/api/accounts/${account.id}/refresh`, route => route.fulfill({ json: { id: account.id, status: "connected" } }));
  const reconnectSync = syncResponse();
  await warning.getByRole("button", { name: "Reconnect from browser session" }).click();
  assert((await reconnectSync).ok());
  await warning.waitFor({ state: "hidden" });

  // Remote drift must preserve the local edit and appear outside chat.
  const edited = original.replace("Original.", "My local edit.");
  writeFileSync(main, edited);
  mock.files.set("main.tex", Buffer.from(original.replace("Original.", "Another remote edit.")));
  await page.getByRole("button", { name: "Sync from remote", exact: true }).click();
  await popup.getByRole("heading", { name: "Sync needs your attention" }).waitFor();
  await popup.getByText("main.tex", { exact: true }).waitFor();
  assert.equal(readFileSync(main, "utf8"), edited);
  await popup.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("tabpanel", { name: "Proof", exact: true }).waitFor();
  await page.getByRole("tabpanel", { name: "Proof", exact: true }).getByText(/My local edit\./).first().waitFor();
  await warning.waitFor();
  await git.discard(config.projectDir(project.id));
  const retry = syncResponse();
  await warning.getByRole("button", { name: "Retry sync" }).click();
  assert((await retry).ok());
  await warning.waitFor({ state: "hidden" });

  // Non-authentication failures on startup also get a popup and retry.
  await page.route(`**/api/projects/${project.id}/sync`, route => route.fulfill({ status: 422, json: { error: "Remote is unreachable — connection refused" } }));
  await page.reload();
  await popup.getByRole("heading", { name: "Could not sync project" }).waitFor();
  await popup.getByText("Remote is unreachable — connection refused", { exact: true }).waitFor();
  await page.unroute(`**/api/projects/${project.id}/sync`);
  const recovered = syncResponse();
  await popup.getByRole("button", { name: "Retry sync" }).click();
  assert((await recovered).ok());
  await popup.waitFor({ state: "hidden" });
  await warning.waitFor({ state: "hidden" });

  // Restart the actual server while the project remains open.
  const restartedSync = syncResponse();
  await stopServer();
  server = startServer();
  await ready();
  assert((await restartedSync).ok());
  await warning.waitFor({ state: "hidden" });

  // An older session check cannot reinstate an error after a newer sync.
  let releaseCheck!: () => void;
  let checkStarted!: () => void;
  const heldCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  const checking = new Promise<void>(resolve => { checkStarted = resolve; });
  await page.route(`**/api/accounts/${account.id}/projects`, async route => {
    checkStarted(); await heldCheck;
    await route.fulfill({ status: 401, json: { error: "The old session has expired — reconnect the account." } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await checking;
  const newSync = syncResponse();
  await page.getByRole("button", { name: "Sync from remote", exact: true }).click();
  assert((await newSync).ok());
  const oldCheck = page.waitForResponse(response => response.url().endsWith(`/api/accounts/${account.id}/projects`));
  releaseCheck(); await oldCheck;
  await page.unroute(`**/api/accounts/${account.id}/projects`);
  await popup.waitFor({ state: "hidden" });
  await warning.waitFor({ state: "hidden" });

  // A late failure from the previous project must not contaminate this one.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/api/projects/${project.id}/sync`, async route => {
    started(); await held;
    await route.fulfill({ status: 422, json: { error: "Delayed failure for the old project" } });
  });
  await page.getByRole("button", { name: "Sync from remote", exact: true }).click();
  await pending;
  await page.getByRole("combobox", { name: "Switch project" }).selectOption(local.id);
  await page.getByRole("heading", { name: "Local notes", exact: true }).waitFor();
  const lateResponse = syncResponse(); release(); await lateResponse;
  await popup.waitFor({ state: "hidden" });
  await warning.waitFor({ state: "hidden" });
  assert.equal(localSyncCount, 0, "local projects do not sync");
  assert.deepEqual(errors, []);
  console.log("Project sync UI passed: open/reload/restart, automatic expiry detection, persistent warning, popup deduplication, reconnect/retry, safe conflicts, late responses and local-project exclusion.");
} finally {
  await browser?.close();
  if (server.exitCode === null) await stopServer();
  await mock.close();
  rmSync(root, { recursive: true, force: true });
}
