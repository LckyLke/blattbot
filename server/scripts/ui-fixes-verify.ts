/**
 * Source autosave base check, file create/rename/delete, main-file choice,
 * project status and Open in Overleaf, keyboard shortcuts and remembered UI
 * state — in a real browser against an isolated server and a mock Overleaf.
 * No model and no TeX engine needed (a compile without one still names its
 * main file, which is what the main-file check reads).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { freePort } from "./free-port.js";
import { startMockOverleaf } from "./mock-overleaf.js";

const root = mkdtempSync(join(tmpdir(), "blattbot-ui-fixes-"));
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const config = await import("../src/config.js");
const accounts = await import("../src/accounts.js");
const git = await import("../src/git.js");
config.ensureDirs();

const MAIN = "\\documentclass{article}\n\\begin{document}\nHello world.\n\n\\input{chapters/intro}\n\\end{document}\n";
const ALT = "\\documentclass{beamer}\n\\begin{document}\nSlides.\n\\end{document}\n";
const INTRO = "\\section{Intro}\nFirst words.\n";

async function fixture(id: string, files: Record<string, string>) {
  const dir = config.projectDir(id);
  mkdirSync(dir, { recursive: true });
  await git.initRepo(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await git.commitAll(dir, "Fixture");
  return dir;
}

const remoteId = "aaaa1111bbbb2222cccc3333";
const mockPort = await freePort();
const mock = await startMockOverleaf(mockPort, remoteId, "Overleaf paper");
const account = accounts.upsertAccount({ baseUrl: `http://127.0.0.1:${mockPort}`, cookie: "overleaf_session2=mock-session" });
const olProject = config.addProject({
  name: "Overleaf paper", kind: "overleaf", gitUrl: "", accountId: account.id,
  overleafBaseUrl: account.baseUrl, overleafProjectId: remoteId, mainTex: "main.tex",
});
await fixture(olProject.id, { "main.tex": MAIN });
mock.files.set("main.tex", Buffer.from(MAIN));

const local = config.addProject({ name: "Local draft", kind: "local", gitUrl: "local", mainTex: "main.tex" });
const dir = await fixture(local.id, { "main.tex": MAIN, "alt.tex": ALT, "chapters/intro.tex": INTRO, "references.bib": "% references\n" });
// One pending change before the browser opens: the dashboard card must show it.
writeFileSync(join(dir, "chapters/intro.tex"), `${INTRO}Pending sentence.\n`);
const disk = (path: string) => readFileSync(join(dir, path), "utf8");

const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(port) },
  stdio: "pipe",
});
let logs = "";
server.stdout.on("data", (c) => { logs += c; });
server.stderr.on("data", (c) => { logs += c; });

/** Poll until `check` holds (disk state the browser changes asynchronously). */
async function until(what: string, check: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/bootstrap`)).ok; } catch { /* booting */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, logs);
  browser = await chromium.launch({
    executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("blattbot.paneLeft.v2")) {
      localStorage.setItem("blattbot.paneLeft.v2", "source");
      localStorage.setItem("blattbot.paneRight.v2", "proof");
    }
  });
  await page.route("**/api/models**", (route) => route.fulfill({ json: { backend: "codex", models: [] } }));
  await page.route("**/api/agent/codex/limits", (route) => route.fulfill({ json: { windows: [], checkedAt: Date.now() } }));
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // ---- Dashboard: status, kind, Open in Overleaf, cheat sheet ----
  await page.goto(base, { waitUntil: "networkidle" });
  const olLink = page.getByRole("link", { name: "Open Overleaf paper in Overleaf", exact: true });
  await olLink.waitFor();
  assert.equal(await olLink.getAttribute("href"), `http://127.0.0.1:${mockPort}/project/${remoteId}`);
  assert.equal(await olLink.getAttribute("target"), "_blank");
  const localCard = page.locator("li").filter({ has: page.getByRole("button", { name: "Open Local draft", exact: true }) });
  await localCard.getByText("1 pending", { exact: true }).waitFor();
  await localCard.getByText("local", { exact: true }).waitFor();
  assert.equal(await localCard.getByRole("link").count(), 0, "no Overleaf link on a local project");

  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await sheet.getByText("Next change in Proof", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });

  // ---- Project view ----
  await page.getByRole("button", { name: "Open Local draft", exact: true }).click();
  const files = page.getByRole("complementary", { name: "Project files" });
  const source = page.locator("#pane-panel-source");
  const proof = page.locator("#pane-panel-proof");
  const sidebar = page.getByRole("navigation", { name: "Project sidebar" });
  await files.waitFor();
  await proof.getByText("chapters/intro.tex", { exact: true }).first().waitFor();
  await sidebar.getByText("1 pending", { exact: true }).waitFor();
  const editor = source.locator(".cm-content");
  const typeAtEnd = async (text: string) => {
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(text);
  };

  // ---- Autosave never writes over a file that changed on disk ----
  await files.getByRole("button", { name: /^main\.tex/ }).click();
  await source.getByText("Hello world.").first().waitFor();
  await typeAtEnd("\n% mine");
  // An agent or sync rewrites the file before the 1.5 s autosave fires.
  writeFileSync(join(dir, "main.tex"), MAIN.replace("Hello world.", "Hello agent world."));
  await source.getByText("changed on disk", { exact: true }).waitFor({ timeout: 8000 });
  await source.getByText(/Not saved: this file changed on disk/).waitFor();
  assert(disk("main.tex").includes("Hello agent world.") && !disk("main.tex").includes("% mine"), "autosave was refused");
  await page.waitForTimeout(2500);
  assert(!disk("main.tex").includes("% mine"), "autosave stays paused while changed-on-disk shows");
  // Merge keeps both; the merged text is saved by the user, not the timer.
  await source.getByRole("button", { name: "Merge", exact: true }).click();
  await source.getByText("changed on disk", { exact: true }).waitFor({ state: "detached" });
  await page.waitForTimeout(2000);
  assert(!disk("main.tex").includes("% mine"), "a merge is not autosaved");
  await source.getByRole("button", { name: "Save", exact: true }).click();
  await until("merged save", () => disk("main.tex").includes("Hello agent world.") && disk("main.tex").includes("% mine"));
  // Save mine overwrites the changed file after a confirmation.
  await typeAtEnd("\n% second");
  writeFileSync(join(dir, "main.tex"), disk("main.tex").replace("Hello agent world.", "Hello again."));
  await source.getByText("changed on disk", { exact: true }).waitFor({ timeout: 8000 });
  await source.getByRole("button", { name: "Save mine", exact: true }).click();
  const overwrite = page.getByRole("dialog", { name: "Overwrite the changed file?" });
  await overwrite.getByRole("button", { name: "Save mine", exact: true }).click();
  await until("Save mine", () => disk("main.tex").includes("% second") && !disk("main.tex").includes("Hello again."));

  // ---- A restored draft is not autosaved; the open file and Proof mode are remembered ----
  await proof.getByRole("tab", { name: "Rendered diff" }).click();
  await files.getByRole("button", { name: /^intro\.tex/ }).click();
  await source.getByText("First words.").first().waitFor();
  await typeAtEnd("% draft");
  await page.waitForTimeout(700); // stored (400 ms debounce), autosave not due yet (1.5 s)
  // A reload with only stored drafts and pending changes asks nothing (a
  // beforeunload prompt would be dismissed and this reload time out).
  await page.reload({ waitUntil: "networkidle" });
  await source.getByText(/^chapters\/intro\.tex/).first().waitFor();
  await source.getByText("% draft").first().waitFor();
  assert.equal(await proof.getByRole("tab", { name: "Rendered diff" }).getAttribute("aria-selected"), "true");
  await page.waitForTimeout(2500);
  assert(!disk("chapters/intro.tex").includes("% draft"), "a restored draft waits for the user to type");
  await typeAtEnd(" ok");
  await until("autosave after typing", () => disk("chapters/intro.tex").includes("% draft ok"));
  await proof.getByRole("tab", { name: "Text diff" }).click();

  // ---- New file, rename, delete — each a pending change in Proof ----
  await files.getByRole("button", { name: "New file", exact: true }).click();
  await files.getByRole("textbox", { name: "New file path" }).fill("sections/results.tex");
  await page.keyboard.press("Enter");
  await files.getByRole("button", { name: /^results\.tex/ }).waitFor();
  await proof.getByText("sections/results.tex", { exact: true }).first().waitFor();
  assert(existsSync(join(dir, "sections/results.tex")));

  await files.locator('[data-file-actions="alt.tex"]').click();
  await page.getByRole("menuitem", { name: "Rename or move…" }).click();
  await files.getByRole("textbox", { name: "New path for alt.tex" }).fill("drafts/alt-renamed.tex");
  await page.keyboard.press("Enter");
  await files.getByRole("button", { name: /^alt-renamed\.tex/ }).waitFor();
  await proof.getByText("drafts/alt-renamed.tex", { exact: true }).first().waitFor();
  assert(!existsSync(join(dir, "alt.tex")) && existsSync(join(dir, "drafts/alt-renamed.tex")));

  await files.locator('[data-file-actions="references.bib"]').click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: "Delete references.bib?" }).getByRole("button", { name: "Delete file" }).click();
  await files.getByRole("button", { name: /^references\.bib/ }).waitFor({ state: "detached" });
  await proof.locator("section").filter({ hasText: "references.bib" }).getByText("deleted", { exact: true }).waitFor();
  assert(!existsSync(join(dir, "references.bib")));

  await files.getByRole("button", { name: /sections\/$/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "New file in this folder…" }).click();
  assert.equal(await files.getByRole("textbox", { name: "New file path" }).inputValue(), "sections/");
  await page.keyboard.press("Escape");
  await files.getByRole("textbox", { name: "New file path" }).waitFor({ state: "detached" });

  // ---- Keyboard shortcuts ----
  await blur();
  await sidebar.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  const rightTabs = page.getByRole("tablist", { name: "Right pane view" });
  await blur();
  await page.keyboard.press("4");
  await rightTabs.locator('[role="tab"][aria-selected="true"]', { hasText: "PDF" }).waitFor();
  await page.keyboard.press("j"); // shows Proof again and marks the first change
  await rightTabs.locator('[role="tab"][aria-selected="true"]', { hasText: "Proof" }).waitFor();
  const current = proof.locator('[data-proof-hunk][data-current="true"]');
  await current.waitFor();
  const first = await current.getAttribute("aria-label");
  await page.keyboard.press("j");
  await page.waitForFunction((label) => document.querySelector('[data-proof-hunk][data-current="true"]')?.getAttribute("aria-label") !== label, first);
  await page.keyboard.press("k");
  await page.waitForFunction((label) => document.querySelector('[data-proof-hunk][data-current="true"]')?.getAttribute("aria-label") === label, first);
  const headBefore = (await git.revParse(dir, "HEAD"));
  await page.keyboard.press("Shift+A");
  const approveAll = page.getByRole("dialog", { name: "Approve & push all changes?" });
  await approveAll.waitFor();
  await approveAll.getByRole("button", { name: "Cancel", exact: true }).click();
  await approveAll.waitFor({ state: "detached" });
  assert.equal(await git.revParse(dir, "HEAD"), headBefore, "cancelled approve-all commits nothing");
  await page.keyboard.press("c");
  await page.waitForFunction(() => document.activeElement?.classList.contains("chat-composer-input") ?? false);
  // Typing in the composer is never a shortcut.
  await page.keyboard.type("1j");
  assert.equal(await page.locator("textarea.chat-composer-input").inputValue(), "1j");
  await page.locator("textarea.chat-composer-input").fill("");

  // ---- Main file: settings pick it, a visible PDF rebuilds it ----
  await blur();
  await page.keyboard.press("4");
  const settings = page.getByRole("dialog", { name: "Project settings" });
  await sidebar.getByRole("button", { name: "Open project settings", exact: true }).click();
  const mainSelect = settings.getByRole("combobox", { name: "Main file" });
  await mainSelect.waitFor();
  assert.deepEqual(
    await mainSelect.locator("option").allTextContents(),
    ["drafts/alt-renamed.tex", "main.tex"],
    "only files with a \\documentclass are offered",
  );
  const rebuilt = page.waitForResponse(
    async (r) => r.url().endsWith(`/api/projects/${local.id}/compile`) && r.request().method() === "POST" &&
      (await r.json().catch(() => ({}))).mainTex === "drafts/alt-renamed.tex",
    { timeout: 30_000 },
  );
  await mainSelect.selectOption("drafts/alt-renamed.tex");
  await settings.getByRole("button", { name: "Save project settings" }).click();
  await settings.getByText("Saved.").waitFor();
  await rebuilt;
  await settings.getByRole("button", { name: "Close project settings" }).click();
  await settings.waitFor({ state: "detached" });
  const chosen = config.getProject(local.id)!;
  assert.equal(chosen.mainTex, "drafts/alt-renamed.tex");
  assert.equal(chosen.mainTexChosen, true);
  await page.keyboard.press("3");
  await files.getByRole("button", { name: /^alt-renamed\.tex\s*main$/i }).waitFor();

  // ---- An Overleaf project: header and sidebar link ----
  await page.getByRole("button", { name: "Back to the project dashboard" }).click();
  await page.getByRole("dialog", { name: "Unapproved changes" }).getByRole("button", { name: "Go to dashboard" }).click();
  await page.getByRole("button", { name: "Open Overleaf paper", exact: true }).click();
  const headerLink = page.locator("header").getByRole("link", { name: "Open Overleaf paper in Overleaf" });
  await headerLink.waitFor();
  assert.equal(await headerLink.getAttribute("href"), `http://127.0.0.1:${mockPort}/project/${remoteId}`);
  await sidebar.getByRole("link", { name: "Open Overleaf paper in Overleaf" }).waitFor();
  await sidebar.getByText("overleaf", { exact: true }).waitFor();

  assert.deepEqual(errors, []);
  console.log(
    "UI fixes passed: autosave refuses a changed file (Merge, Save mine), restored drafts wait for typing, " +
      "remembered open file and Proof mode, create/rename/delete in Proof, main-file choice with rebuild, " +
      "dashboard/sidebar status, Open in Overleaf, shortcuts and cheat sheet.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  await mock.close();
  rmSync(root, { recursive: true, force: true });
}
