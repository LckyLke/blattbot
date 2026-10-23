/**
 * History panel in the real UI against the mock Overleaf: approve a change,
 * sync a co-author's change, see both in History (badge, kinds, diffs),
 * revert the push as pending changes in Proof, approve the revert, and find
 * a forced approval's backup. Run `npm run build` first.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMockOverleaf } from "./mock-overleaf.js";

const SERVER_PORT = 4743;
const MOCK_PORT = 4744;
const root = mkdtempSync(join(tmpdir(), "blattbot-history-ui-"));
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.org\n");
process.env.BLATTBOT_DATA_DIR = join(root, "data");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const config = await import("../src/config.js");
const accounts = await import("../src/accounts.js");
const git = await import("../src/git.js");
config.ensureDirs();
const remoteId = "abcd1111abcd2222abcd3333";
const mock = await startMockOverleaf(MOCK_PORT, remoteId);
const account = accounts.upsertAccount({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, cookie: "overleaf_session2=mock-session" });
const project = config.addProject({
  name: "History paper",
  kind: "overleaf",
  gitUrl: "",
  accountId: account.id,
  overleafBaseUrl: account.baseUrl,
  overleafProjectId: remoteId,
  mainTex: "main.tex",
});
const dir = config.projectDir(project.id);
const lines = ["\\documentclass{article}", "\\begin{document}", "Abstract draft.", "", "Middle paragraph.", "", "Closing words.", "\\end{document}"];
const original = lines.join("\n") + "\n";
const replace = (text: string, from: string, to: string) => text.replace(from, to);
mkdirSync(dir, { recursive: true });
await git.initRepo(dir);
writeFileSync(join(dir, "main.tex"), original);
mock.files.set("main.tex", Buffer.from(original));
await git.commitAll(dir, "Initial sync from Overleaf", git.OVERLEAF_AUTHOR);

const base = `http://127.0.0.1:${SERVER_PORT}`;
let logs = "";
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(SERVER_PORT) },
  stdio: "pipe",
});
server.stdout.on("data", (chunk) => (logs += chunk));
server.stderr.on("data", (chunk) => (logs += chunk));

const shots = process.env.BLATTBOT_SHOT_DIR || tmpdir();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + "/api/bootstrap")).ok) break;
    } catch {
      /* starting */
    }
    if (i > 150) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const executablePath =
    process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ id }) => {
    if (!localStorage.getItem("blattbot.selectedProject")) {
      localStorage.setItem("blattbot.selectedProject", id);
      localStorage.setItem("blattbot.view", "project");
      localStorage.setItem("blattbot.paneLeft.v2", "chat");
      localStorage.setItem("blattbot.paneRight.v2", "proof");
    }
  }, { id: project.id });

  const right = page.getByRole("tablist", { name: "Right pane view" });
  const historyTab = right.getByRole("tab", { name: /^History/ });
  const proofTab = right.getByRole("tab", { name: "Proof" });
  const proof = page.getByRole("tabpanel", { name: "Proof", exact: true });
  const history = page.getByRole("tabpanel", { name: "History", exact: true });
  const chat = page.getByRole("tabpanel", { name: "Chat", exact: true });
  const syncDone = () =>
    page.waitForResponse((r) => r.url() === `${base}/api/projects/${project.id}/sync` && r.request().method() === "POST");

  // 1. My change, approved and pushed.
  const mine = replace(original, "Abstract draft.", "A sharper abstract.");
  writeFileSync(join(dir, "main.tex"), mine);
  const firstSync = syncDone();
  await page.goto(base);
  assert((await firstSync).ok());
  await proof.getByText("A sharper abstract.").first().waitFor();
  await proof.getByText("Commit message (local history only)", { exact: true }).waitFor();
  const message = proof.getByLabel("Commit message (local history only)");
  assert.equal(await message.getAttribute("placeholder"), "BlattBot edit");
  await message.fill("Sharpen the abstract");
  await proof.getByRole("button", { name: "Approve & push" }).click();
  await chat.getByText("Changes pushed to Overleaf: main.tex.", { exact: true }).waitFor();
  assert.equal(mock.files.get("main.tex")?.toString(), mine, "the approval reached Overleaf");

  // 2. A co-author edits another paragraph on Overleaf; Sync picks it up.
  const coauthor = replace(mine, "Closing words.", "Closing words, revised by a co-author.");
  mock.files.set("main.tex", Buffer.from(coauthor));
  const manualSync = syncDone();
  await page.getByRole("button", { name: "Sync from remote", exact: true }).click();
  assert((await manualSync).ok());
  // The History tab counts the incoming commit before it is opened.
  const badge = historyTab.locator('span[title="1 new from Overleaf"]');
  await badge.waitFor();

  // 3. History: both entries, the incoming one marked new, with diffs.
  await historyTab.click();
  await history.getByRole("heading", { name: "Today" }).waitFor();
  const syncEntry = history.getByRole("button", { name: /From Overleaf.*Sync from Overleaf.*new/ });
  const pushEntry = history.getByRole("button", { name: /Pushed by you.*Sharpen the abstract.*Grace Hopper/ });
  await syncEntry.waitFor();
  await pushEntry.waitFor();
  await history.getByRole("button", { name: /From Overleaf.*Initial sync from Overleaf/ }).waitFor();
  await badge.waitFor({ state: "detached" });
  await syncEntry.click();
  await history.getByText("Closing words, revised by a co-author.").waitFor();
  await pushEntry.click();
  await history.getByText("A sharper abstract.").waitFor();
  await history.getByRole("tab", { name: "From Overleaf" }).click();
  await pushEntry.waitFor({ state: "detached" });
  await syncEntry.waitFor();
  await history.getByRole("tab", { name: "Pushed by me" }).click();
  await syncEntry.waitFor({ state: "detached" });
  await pushEntry.waitFor();
  await page.screenshot({ path: join(shots, "blattbot-history-panel.png") });

  // 4. Revert the push: pending changes in Proof, the co-author's edit kept.
  if ((await pushEntry.getAttribute("aria-expanded")) !== "true") await pushEntry.click();
  await history.getByRole("button", { name: /^Revert / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revert as pending changes" }).click();
  await proof.waitFor();
  assert.equal(await proofTab.getAttribute("aria-selected"), "true", "the revert opens Proof");
  await proof.getByText("Abstract draft.").first().waitFor();
  await proof.locator(`input[placeholder='Revert "Sharpen the abstract"']`).waitFor();
  const head = (await git.logCommits(dir, { max: 1 }))[0];
  assert.match(head.body, /^Sync from Overleaf/, "the revert committed nothing");
  await chat.getByText(/^Reverted [0-9a-f]{7} "Sharpen the abstract" as pending changes/).waitFor();

  // 5. Approve notices survive a reload; then approve the revert.
  const reloadSync = syncDone();
  await page.reload();
  await reloadSync;
  await chat.getByText("Changes pushed to Overleaf: main.tex.", { exact: true }).waitFor();
  await chat.getByText(/^Reverted [0-9a-f]{7} "Sharpen the abstract"/).waitFor();
  await proof.getByText("Abstract draft.").first().waitFor();
  await proof.getByRole("button", { name: "Approve & push" }).click();
  await chat.getByText("Changes pushed to Overleaf: main.tex.", { exact: true }).nth(1).waitFor();
  assert.equal(
    mock.files.get("main.tex")?.toString(),
    replace(coauthor, "A sharper abstract.", "Abstract draft."),
    "the revert undid only my change on Overleaf",
  );
  await historyTab.click();
  await history.getByRole("button", { name: /Revert.*Revert "Sharpen the abstract"/ }).waitFor();

  // 6. A forced approval keeps Overleaf's version as a backup, listed in History.
  // Both sides edit the same line; reopening the project reports the drift.
  await proofTab.click();
  const pushed = mock.files.get("main.tex")!.toString();
  writeFileSync(join(dir, "main.tex"), replace(pushed, "Middle paragraph.", "My middle."));
  mock.files.set("main.tex", Buffer.from(replace(pushed, "Middle paragraph.", "Their middle.")));
  const driftSync = syncDone();
  await page.reload();
  await driftSync;
  const popup = page.getByRole("dialog");
  await popup.getByRole("heading", { name: "Sync needs your attention" }).waitFor();
  await popup.getByRole("button", { name: "Review changes" }).click();
  await proof.getByText("My middle.").first().waitFor();
  await proof.getByRole("button", { name: "Approve & push" }).click();
  await proof.getByText(/you also\s+edited — nothing was pushed/).waitFor();
  await proof.getByRole("button", { name: "Overwrite Overleaf" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Overwrite Overleaf" }).click();
  await chat.getByText(/were backed up before they were overwritten — open History → Overleaf backups/).waitFor();
  await historyTab.click();
  const backups = history.getByRole("region", { name: "Overleaf backups" });
  const view = backups.getByRole("link", { name: "View the backup of main.tex" });
  await view.waitFor();
  const stamps = readdirSync(join(dir, ".git", "blattbot", "remote-backup"));
  assert.equal(stamps.length, 1);
  const href = await view.getAttribute("href");
  const backupText = await page.evaluate(async (url) => (await fetch(url!)).text(), href);
  assert.match(backupText, /Their middle\./, "the backup holds Overleaf's overwritten version");
  await page.screenshot({ path: join(shots, "blattbot-history-backups.png") });

  assert.deepEqual(errors, []);
  console.log(
    "History UI passed: approve + co-author sync listed with kinds, authors, unread badge and diffs; filters; revert as pending changes in Proof with its default message; persisted approve notices; approved revert; forced-approval backup listed and served.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await stopped;
  }
  await mock.close();
  rmSync(root, { recursive: true, force: true });
}
