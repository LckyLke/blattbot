/** Verify bulk reference cleanup against an isolated real server, without model calls. */
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "blattbot-cleanup-"));
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const config = await import("../src/config.js");
const project = config.addProject({ name: "Reference cleanup", kind: "local", gitUrl: "", mainTex: "main.tex" });
const dir = config.projectDir(project.id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "main.tex"), "\\cite{kept}\n");
const bib = "@misc{kept,title={Cited paper}}\n@misc{stale,title={Newly cited paper}}\n@misc{unused,title={Unused paper}}\n";
writeFileSync(join(dir, "refs.bib"), bib);
execFileSync("git", ["-C", dir, "init", "-b", "main"]);
execFileSync("git", ["-C", dir, "add", "."]);
execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-m", "Fixture"]);
const base = "http://127.0.0.1:4597";
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: "4597" }, stdio: "pipe",
});
let logs = "";
server.stdout.on("data", c => { logs += c; }); server.stderr.on("data", c => { logs += c; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + "/api/bootstrap")).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("blattbot.paneLeft.v2", "refs");
    localStorage.setItem("blattbot.paneRight.v2", "source");
  });
  await page.route("**/api/models**", route => route.fulfill({ json: { backend: "codex", models: [] } }));
  await page.route("**/api/agent/codex/limits", route => route.fulfill({ json: { windows: [], checkedAt: Date.now() } }));
  await page.goto(base);
  await page.getByRole("button", { name: "Open Reference cleanup", exact: true }).click();
  // The view identifier is 'refs'; explicitly select References as a fallback.
  await page.getByRole("tablist", { name: "Left pane view" }).getByRole("tab", { name: "References", exact: true }).click();
  const button = page.getByTitle("Remove all unused bibliography entries; review or undo in Proof", { exact: true });
  await button.waitFor();
  await page.getByRole("button", { name: "unused (2)", exact: true }).waitFor();
  await button.click();
  let confirm = page.getByRole("dialog", { name: "Delete 2 unused references?", exact: true });
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(readFileSync(join(dir, "refs.bib"), "utf8"), bib);
  await button.click();
  await confirm.waitFor();
  // The server must re-read usage after the dialog opened.
  writeFileSync(join(dir, "main.tex"), "\\cite{kept,stale}\n");
  await confirm.getByRole("button", { name: "Delete unused", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Deleted 1 unused reference." }).waitFor();
  assert(!readFileSync(join(dir, "refs.bib"), "utf8").includes("@misc{unused"));
  assert(readFileSync(join(dir, "refs.bib"), "utf8").includes("@misc{stale"));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some(b => b.textContent?.trim() === "Delete unused" && b.disabled));
  const diff = await (await page.request.get(base + "/api/projects/" + project.id + "/diff")).json();
  assert(JSON.stringify(diff).includes("-@misc{unused"));
  await page.screenshot({ path: "/tmp/blattbot-delete-unused.png", fullPage: true });
  const rejected = await page.request.post(base + "/api/projects/" + project.id + "/reject");
  assert(rejected.ok());
  assert.equal(readFileSync(join(dir, "refs.bib"), "utf8"), bib);
  assert.deepEqual(errors, []);
  console.log("Reference cleanup passed: confirmation/cancel, fresh usage, preserved citations, disabled empty state, reviewable diff, undo.");
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
