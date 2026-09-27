/** Real sidebar interactions with isolated projects and repository fixtures. */
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "blattbot-sidebar-"));
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const config = await import("../src/config.js");
const repositories = await import("../src/repositories.js");
const name = "Proof-Supervised Prior-Fitted Networks";
const project = config.addProject({ name, kind: "git", gitUrl: join(root, "remote.git"), mainTex: "main.tex" });
const other = config.addProject({ name: "Literature notes", kind: "local", gitUrl: "", mainTex: "main.tex" });
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
function fixture(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git(dir, "init", "-b", "main"); git(dir, "add", ".");
  git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-m", "Fixture");
}
const dir = config.projectDir(project.id);
fixture(dir, { "main.tex": "\\documentclass{article}\n\\begin{document}Fixture\\end{document}", "references.bib": "",
  "figures/double-equivariance.tex": "% Figure", "figures/lift-limitation.tex": "% Figure" });
fixture(config.projectDir(other.id), { "main.tex": "Notes" });
git(dir, "clone", "--bare", dir, project.gitUrl); git(dir, "remote", "add", "origin", project.gitUrl);
git(dir, "fetch", "origin"); git(dir, "branch", "--set-upstream-to=origin/main");
const code = join(root, "dice-embeddings"); fixture(code, { "model.py": "def loss(x): return x.mean()\n" });
git(code, "branch", "-m", "kgfm_cqd");
await repositories.attachRepository(project.id, { source: code, ref: "kgfm_cqd" });
const chats = await import("../src/chats.js");
const firstChat = chats.ensureActiveChat(project.id);
chats.updateChat(project.id, firstChat.id, { title: "Review the introduction" });
chats.appendEvent(project.id, firstChat.id, { type: "text_final", text: "First conversation transcript." });
const secondChat = chats.createChat(project.id);
chats.updateChat(project.id, secondChat.id, { title: "Check the references" });
chats.appendEvent(project.id, secondChat.id, { type: "text_final", text: "Second conversation transcript." });
const port = 4596, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), env: { ...process.env, BLATTBOT_PORT: String(port) }, stdio: "pipe",
});
let logs = ""; server.stdout.on("data", c => { logs += c; }); server.stderr.on("data", c => { logs += c; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + "/api/bootstrap")).ok; if (ready) break; } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(projectId => {
    localStorage.setItem(`blattbot.scope.${projectId}`, JSON.stringify(["main.tex"]));
    localStorage.setItem("blattbot.paneLeft.v2", "chat");
    localStorage.setItem("blattbot.paneRight.v2", "source");
  }, project.id);
  await page.route("**/api/models**", route => route.fulfill({ json: { backend: "codex", models: [] } }));
  await page.route("**/api/agent/codex/limits", route => route.fulfill({ json: { windows: [], checkedAt: Date.now() } }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  const sidebar = page.getByRole("navigation", { name: "Project sidebar", exact: true });
  const first = sidebar.getByRole("button", { name: "Open chat Review the introduction", exact: true });
  const second = sidebar.getByRole("button", { name: "Open chat Check the references", exact: true });
  assert.equal(await sidebar.getByRole("checkbox").count(), 0);
  await first.waitFor();
  assert.equal(await first.getAttribute("aria-current"), "page");
  // Opening a sidebar chat reveals Chat even while the pane shows Source/Proof.
  await page.getByRole("tablist", { name: "Left pane view" }).getByRole("tab", { name: "Proof", exact: true }).click();
  await second.click();
  await page.getByText("Second conversation transcript.", { exact: true }).waitFor();
  assert.equal(await second.getAttribute("aria-current"), "page");
  await first.focus(); await first.press("Enter");
  await page.getByText("First conversation transcript.", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await first.waitFor();
  assert.equal(await first.getAttribute("aria-current"), "page");
  await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
  const created = sidebar.getByRole("button", { name: "Open chat New chat", exact: true });
  await created.waitFor();
  assert.equal(await created.getAttribute("aria-current"), "page");
  await sidebar.getByRole("button", { name: "Delete New chat", exact: true }).click();
  await sidebar.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await created.count(), 1);
  await sidebar.getByRole("button", { name: "Delete New chat", exact: true }).click();
  await sidebar.getByRole("button", { name: "Really delete New chat?", exact: true }).click();
  await created.waitFor({ state: "detached" });
  await sidebar.getByRole("combobox", { name: "Switch project", exact: true }).selectOption(other.id);
  await sidebar.getByRole("heading", { name: other.name, exact: true }).waitFor();
  assert.equal(await first.count(), 0);
  await sidebar.getByRole("combobox", { name: "Switch project", exact: true }).selectOption(project.id);
  await sidebar.getByRole("heading", { name, exact: true }).waitFor();
  await first.waitFor();
  await sidebar.getByText("dice-embeddings", { exact: true }).waitFor();
  await sidebar.screenshot({ path: "/tmp/blattbot-sidebar.png", animations: "disabled" });
  await sidebar.getByRole("button", { name: "Open project settings", exact: true }).click();
  await page.getByRole("button", { name: "Close project settings", exact: true }).click();
  const synced = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}/sync`));
  await sidebar.getByRole("button", { name: "Sync from remote", exact: true }).click();
  assert((await synced).ok());
  await sidebar.getByRole("button", { name: "Refresh revision", exact: true }).click();
  await sidebar.getByRole("status").waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: "Add external context", exact: true }).click();
  await sidebar.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Reference notes") });
  await sidebar.getByRole("link", { name: "notes.txt", exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "Close the external-context form", exact: true }).click();
  await sidebar.getByRole("button", { name: "Delete notes.txt", exact: true }).click();
  await sidebar.getByRole("link", { name: "notes.txt", exact: true }).waitFor({ state: "detached" });
  assert(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth));
  // Park Chat on the right before switching to the single-pane mobile layout.
  await page.getByRole("tablist", { name: "Right pane view" }).getByRole("tab", { name: "Chat", exact: true }).click();
  await page.setViewportSize({ width: 580, height: 760 });
  await page.getByRole("button", { name: "Toggle project sidebar", exact: true }).click();
  await sidebar.waitFor();
  assert(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth));
  await sidebar.screenshot({ path: "/tmp/blattbot-sidebar-mobile.png", animations: "disabled" });
  await sidebar.getByRole("button", { name: "Remove", exact: true }).click();
  await sidebar.getByText("dice-embeddings", { exact: true }).waitFor({ state: "detached" });
  // Selecting a chat also dismisses the mobile sidebar.
  await first.click();
  await sidebar.waitFor({ state: "hidden" });
  await page.getByRole("textbox", { name: "Message BlattBot", exact: true }).fill("Inspect the whole project.");
  let sent: any;
  await page.route(`**/api/projects/${project.id}/chat`, route => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { error: "Fixture: no model request" } });
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Fixture: no model request", { exact: true }).waitFor();
  assert.equal(sent.message, "Inspect the whole project.");
  assert.equal(Object.hasOwn(sent, "files"), false, "Legacy scope preferences must not restrict new turns");
  assert.deepEqual(errors, []);
  console.log("Sidebar passed: project switching, chat creation/selection/deletion/reload, keyboard, whole-project context, settings, sync, repository refresh/remove, context upload/delete, mobile layout.");
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
