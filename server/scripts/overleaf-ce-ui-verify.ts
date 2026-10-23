/**
 * The built BlattBot app in a real browser against a REAL Overleaf server
 * (Community Edition in Docker, see CONTRIBUTING.md): import a project,
 * approve an edit in Proof, let a co-author type on Overleaf (quiet
 * auto-sync, then the "Overleaf changed" notice with a pending edit and Sync
 * now), approve again, and check History. A second realtime session of the
 * same account plays the co-author.
 *
 *   npm run build
 *   BLATTBOT_CE_URL=… BLATTBOT_CE_COOKIE=… npx tsx scripts/overleaf-ce-ui-verify.ts   (from server/)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { freePort } from "./free-port.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ceUrl = process.env.BLATTBOT_CE_URL?.replace(/\/+$/, "");
const ceCookie = process.env.BLATTBOT_CE_COOKIE;
if (!ceUrl || !ceCookie) {
  console.error("Set BLATTBOT_CE_URL and BLATTBOT_CE_COOKIE (an overleaf.sid=… session cookie).");
  process.exit(2);
}
const dataDir = mkdtempSync(join(tmpdir(), "blattbot-ui-ce-"));
process.env.BLATTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "blattbot-ui-ce-helper-"));
const { OverleafClient, buildTree } = await import("../src/overleaf/olclient.js");
const { publishTree } = await import("../src/sync.js");
const { unpackZip } = await import("../src/overleaf/olsync.js");
const { computeTextOpHunks } = await import("../src/overleaf/ot.js");

const client = new OverleafClient(ceUrl, ceCookie);
const LINES = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the paper.`);
const MAIN = `\\documentclass{article}\n\\begin{document}\n${LINES.join("\n")}\n\\end{document}\n`;
const src = mkdtempSync(join(tmpdir(), "blattbot-ui-ce-src-"));
writeFileSync(join(src, "main.tex"), MAIN);
const { remoteProjectId: remoteId } = await publishTree(client, `BlattBot UI e2e ${Date.now()}`, src, "main.tex");
const remoteMain = async () => unpackZip(await client.downloadZip(remoteId)).get("main.tex")!.toString("utf8");
async function coauthor(edit: (t: string) => string) {
  const s = await client.connectRealtime(remoteId);
  try {
    const id = buildTree(s.project).entities.get("main.tex")!.id;
    const d = await s.joinDoc(id);
    const text = d.lines.join("\n");
    await s.applyOtUpdate(id, computeTextOpHunks(text, edit(text)), d.version);
    await s.joinDoc(id);
  } finally {
    s.close();
  }
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let logs = "";
const server = spawn(process.execPath, ["bin/blattbot.js", "--port", String(port), "--data-dir", dataDir, "--no-open"], {
  cwd: SERVER,
  env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
  stdio: "pipe",
});
server.stdout.on("data", (c) => { logs += c; });
server.stderr.on("data", (c) => { logs += c; });
for (let i = 0; i < 200; i++) {
  try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 100));
}

const executablePath =
  process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-proxy-server"] });
const step = (s: string) => console.log(`• ${s}`);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { void d.accept(); });
  await page.clock.install();
  await page.goto(base);

  step("connect the CE account and import the project through the API the dashboard uses");
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const headers = { Authorization: `Bearer ${token}` };
  const acct = await (await page.request.post(`${base}/api/accounts`, { headers, data: { url: ceUrl, cookie: ceCookie } })).json();
  assert(acct.id, `account: ${JSON.stringify(acct)}`);
  const proj = await (await page.request.post(`${base}/api/projects`, { headers, data: { accountId: acct.id, projectId: remoteId } })).json();
  assert(proj.id, `project: ${JSON.stringify(proj)}`);
  const mirror = join(dataDir, "projects", proj.id, "main.tex");
  await page.evaluate((id) => {
    localStorage.setItem("blattbot.selectedProject", id);
    localStorage.setItem("blattbot.view", "project");
    localStorage.setItem("blattbot.paneLeft.v2", "chat");
    localStorage.setItem("blattbot.paneRight.v2", "proof");
  }, proj.id);
  const syncResponse = () => page.waitForResponse((r) => r.url() === `${base}/api/projects/${proj.id}/sync`);
  let sync = syncResponse();
  await page.reload();
  assert((await sync).ok());
  const proof = page.getByRole("tabpanel", { name: "Proof", exact: true });
  await proof.getByText(/No pending changes/).waitFor();
  assert.equal(readFileSync(mirror, "utf8"), MAIN);

  step("edit locally, approve in Proof, and find the edit on Overleaf");
  writeFileSync(mirror, readFileSync(mirror, "utf8").replace("Line 5 of the paper.", "Line 5, edited in BlattBot."));
  sync = syncResponse();
  await page.reload();
  await sync;
  await proof.getByText(/Line 5, edited in BlattBot\./).first().waitFor();
  await proof.getByRole("button", { name: "Approve & push" }).click();
  await page.getByText(/Changes pushed to Overleaf/).first().waitFor({ timeout: 60_000 });
  await proof.getByText(/No pending changes/).waitFor();
  assert.match(await remoteMain(), /Line 5, edited in BlattBot\./);

  step("a co-author types on Overleaf: with nothing pending, the minute check syncs quietly");
  await coauthor((t) => t.replace("Line 12 of the paper.", "Line 12, typed by a co-author."));
  sync = syncResponse();
  await page.clock.fastForward(60_001);
  assert((await sync).ok());
  for (let i = 0; i < 50 && !readFileSync(mirror, "utf8").includes("Line 12, typed by a co-author."); i++) await new Promise((r) => setTimeout(r, 200));
  assert.match(readFileSync(mirror, "utf8"), /Line 12, typed by a co-author\./);

  step("with a pending edit, a co-author change shows the notice; Sync now merges both");
  writeFileSync(mirror, readFileSync(mirror, "utf8").replace("Line 20 of the paper.", "Line 20, pending in BlattBot."));
  sync = syncResponse();
  await page.reload();
  await sync;
  await proof.getByText(/Line 20, pending in BlattBot\./).first().waitFor();
  await coauthor((t) => t.replace("Line 30 of the paper.", "Line 30, typed by a co-author."));
  const notice = page.getByRole("status", { name: "Overleaf changed" });
  await page.clock.fastForward(60_001);
  await notice.waitFor({ timeout: 30_000 });
  sync = syncResponse();
  await notice.getByRole("button", { name: "Sync now" }).click();
  assert((await sync).ok());
  await notice.waitFor({ state: "hidden" });
  const merged = readFileSync(mirror, "utf8");
  assert.match(merged, /Line 20, pending in BlattBot\./);
  assert.match(merged, /Line 30, typed by a co-author\./);

  step("approve the pending edit; Overleaf ends with every edit");
  await proof.getByRole("button", { name: "Approve & push" }).click();
  await proof.getByText(/No pending changes/).waitFor({ timeout: 60_000 });
  const remote = await remoteMain();
  for (const s of ["Line 5, edited in BlattBot.", "Line 12, typed by a co-author.", "Line 20, pending in BlattBot.", "Line 30, typed by a co-author."]) {
    assert(remote.includes(s), `missing on Overleaf: ${s}`);
  }

  step("History lists the co-author changes and the pushes");
  await page.getByRole("tablist", { name: "Left pane view" }).getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("tabpanel", { name: "History", exact: true });
  await history.getByText(/Sync from Overleaf/).first().waitFor();
  await page.screenshot({ path: join(tmpdir(), "blattbot-overleaf-ce-history.png") });
  assert.deepEqual(errors, []);
  console.log("UI end-to-end against Overleaf CE passed.");
} catch (err) {
  console.error(err);
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
