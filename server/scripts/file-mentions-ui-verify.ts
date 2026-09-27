/** Real file-mention interactions with isolated project and repository fixtures. */
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
const port = 4598, base = `http://127.0.0.1:${port}`;
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
  const input = page.getByRole("textbox", { name: "Message BlattBot", exact: true });
  await input.fill("Compare @main");
  await page.getByRole("option").filter({ hasText: "main.tex" }).waitFor();
  await input.press("Enter");
  assert.equal(await input.inputValue(), "Compare @{project/main.tex} ");
  await input.press("End");
  await input.pressSequentially("with @model");
  await page.getByRole("option").filter({ hasText: "model.py" }).waitFor();
  await page.screenshot({ path: "/tmp/blattbot-file-mentions.png" });
  await input.press("Tab");
  assert.match(await input.inputValue(), /@\{repo\/dice-embeddings\/model.py\}/);
  let sent: any;
  await page.route(`**/api/projects/${project.id}/chat`, route => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { error: "Fixture: no model request" } });
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Fixture: no model request", { exact: true }).waitFor();
  assert.equal(sent.mentions.length, 2);
  assert.equal(sent.mentions[1].commit, git(code, "rev-parse", "HEAD").toString().trim());
  assert.equal(Object.hasOwn(sent, "files"), false);
  const { resolveFileMentions, promptWithFileMentions } = await import("../src/file-mentions.js");
  const resolved = await resolveFileMentions(project.id, sent.mentions, sent.message);
  assert.equal(resolved.length, 2);
  assert(promptWithFileMentions(sent.message, resolved).includes("inspect_repository"));
  await assert.rejects(resolveFileMentions(project.id, [{ source: "project", path: "../secret" }], "test"));
  await assert.rejects(resolveFileMentions(project.id, [{ ...sent.mentions[1], path: "missing.py" }], "test"));
  assert.deepEqual(await resolveFileMentions(project.id, sent.mentions, "removed tokens"), []);
  await input.waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Fixture: no model request", { exact: true }).waitFor();
  assert.equal(sent.mentions.length, 2, "Retry retains mention metadata");
  await input.fill("@missing-file");
  await page.getByText("No matching files.", { exact: true }).waitFor();
  await input.press("Escape");
  await page.getByRole("listbox", { name: "File mentions" }).waitFor({ state: "detached" });
  await input.fill("mail@example.org");
  assert.equal(await page.getByRole("listbox", { name: "File mentions" }).count(), 0);
  const { mentionQuery, insertMention } = await import("../../web/src/file-mentions.js");
  assert.equal(mentionQuery("mail@example.org", 16), null);
  assert.equal(mentionQuery("@{project/main.tex} ", 20), null);
  assert.deepEqual(insertMention("Look @mai after", { start: 5, end: 9 }, "@{project/main.tex}"), { text: "Look @{project/main.tex}  after", caret: 25 });
  assert.deepEqual(errors, []);
  console.log("File mentions passed: project/repository search, keyboard selection, snapshot metadata, server validation, retry, dismissal, email exclusion, insertion.");
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
