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
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  const sidebar = page.getByRole("navigation", { name: "Project sidebar", exact: true });
  const main = sidebar.getByRole("checkbox", { name: "Scope main.tex", exact: true });
  await main.check();
  await sidebar.getByText("1 file", { exact: true }).waitFor();
  const figures = sidebar.getByRole("button", { name: "figures", exact: true });
  await figures.click(); assert.equal(await figures.getAttribute("aria-expanded"), "false");
  assert.equal(await sidebar.getByRole("checkbox", { name: "Scope figures/double-equivariance.tex", exact: true }).count(), 0);
  await figures.click();
  await sidebar.getByRole("checkbox", { name: "Scope figures/double-equivariance.tex", exact: true }).check();
  await sidebar.getByRole("combobox", { name: "Switch project", exact: true }).selectOption(other.id);
  await sidebar.getByRole("heading", { name: other.name, exact: true }).waitFor();
  assert(!await main.isChecked());
  await sidebar.getByRole("combobox", { name: "Switch project", exact: true }).selectOption(project.id);
  await sidebar.getByRole("heading", { name, exact: true }).waitFor();
  assert(await main.isChecked());
  await sidebar.getByRole("button", { name: "Clear file selection", exact: true }).click();
  assert(!await main.isChecked());
  await sidebar.getByText("dice-embeddings", { exact: true }).waitFor();
  await sidebar.screenshot({ path: "/tmp/blattbot-sidebar.png", animations: "disabled" });
  await main.focus(); await main.press("Space"); assert(await main.isChecked());
  await sidebar.screenshot({ path: "/tmp/blattbot-sidebar-selected.png", animations: "disabled" });
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
  await page.setViewportSize({ width: 580, height: 760 });
  await page.getByRole("button", { name: "Toggle project files", exact: true }).click();
  await sidebar.waitFor();
  assert(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth));
  await sidebar.screenshot({ path: "/tmp/blattbot-sidebar-mobile.png", animations: "disabled" });
  await sidebar.getByRole("button", { name: "Remove", exact: true }).click();
  await sidebar.getByText("dice-embeddings", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("Sidebar passed: project switching, scope, folders, keyboard, settings, sync, repository refresh/remove, context upload/delete, mobile layout.");
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
