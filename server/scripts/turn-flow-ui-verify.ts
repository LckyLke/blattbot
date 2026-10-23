/**
 * The agent turn lifecycle in the browser, against a fixture OpenAI-compatible
 * endpoint (no real model): typing and queueing a message during a turn,
 * editing a file as a draft while the agent works, the turn-end card (Show
 * changes, Undo turn and its Undo toast), discard with the Undo toast and
 * "Restore last discard", and a queue paused by a failed turn.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { freePort } from "./free-port.js";

const SHOTS = process.env.UI_SHOTS_DIR ?? join(tmpdir(), "blattbot-turn-flow-shots");
mkdirSync(SHOTS, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "blattbot-turn-flow-"));
const dataDir = join(root, "data");
mkdirSync(join(dataDir, "bin"), { recursive: true });
// A fake latexmk: the refresh build after a turn runs instantly and offline.
const fakeLatexmk = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const args = process.argv.slice(2); const main = args[args.length - 1];",
  "const out = args.find((a) => a.startsWith('-outdir=')).split('=')[1];",
  "fs.writeFileSync(path.join(out, path.basename(main, '.tex') + '.pdf'), '%PDF-1.4 fixture\\n');",
].join("\n");
if (process.platform === "win32") {
  writeFileSync(join(dataDir, "bin", "latexmk.js"), fakeLatexmk);
  writeFileSync(join(dataDir, "bin", "latexmk.cmd"), `@node "%~dp0latexmk.js" %*\r\n`);
} else {
  writeFileSync(join(dataDir, "bin", "latexmk"), `#!/usr/bin/env node\n${fakeLatexmk}`, { mode: 0o755 });
}

// ---- The fixture model -------------------------------------------------------
// A message containing [hold] waits until the script releases it; [error]
// then fails the request. A held message edits main.tex; others just answer.
let release: (() => void) | null = null;
const held = () => release !== null;
const prompts: string[] = [];
const modelPort = await freePort();
const model = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const msgs: any[] = body.messages ?? [];
    const last = msgs.at(-1);
    const user = [...msgs].reverse().find((m) => m.role === "user");
    const text = typeof user?.content === "string" ? user.content : "";
    const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = () => {
      res.write("data: [DONE]\n\n");
      res.end();
    };
    if (last?.role !== "tool") {
      prompts.push(text);
      if (text.includes("[hold]")) await new Promise<void>((resolve) => (release = resolve));
      release = null;
      if (text.includes("[error]")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fixture failure" }));
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (last?.role === "tool") {
      sse({ choices: [{ delta: { content: "Rewrote the introduction." } }] });
    } else if (text.includes("[hold]")) {
      const args = JSON.stringify({ path: "main.tex", old_string: "Start writing here.", new_string: "The agent rewrote the introduction." });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${prompts.length}`, function: { name: "edit_file", arguments: args } }] } }] });
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      return finish();
    } else {
      sse({ choices: [{ delta: { content: `Answered: ${text.slice(0, 40)}` } }] });
    }
    sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
    finish();
  });
});
await new Promise<void>((resolve) => model.listen(modelPort, "127.0.0.1", resolve));

// ---- BlattBot --------------------------------------------------------------------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let logs = "";
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(port), BLATTBOT_DATA_DIR: dataDir },
  stdio: "pipe",
});
server.stdout.on("data", (c) => (logs += c));
server.stderr.on("data", (c) => (logs += c));

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const waitUntil = async (what: string, test: () => Promise<boolean> | boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};

try {
  let token = "";
  await waitUntil("server", async () => {
    try {
      const res = await fetch(`${base}/api/bootstrap`);
      if (res.ok) token = (await res.json()).token;
      return res.ok;
    } catch {
      return false;
    }
  }, 30_000);
  const apiCall = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  await apiCall("PUT", "/api/settings", { backend: "openai", openaiBaseUrl: `http://127.0.0.1:${modelPort}/v1`, openaiModel: "fixture-model" });
  const project = await apiCall("POST", "/api/projects", { local: true, name: "Turn Flow Fixture" });
  const fileText = async (path: string) => (await apiCall("GET", `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`)).content as string;
  const originalMain = await fileText("main.tex");

  browser = await chromium.launch({
    executablePath:
      process.env.BLATTBOT_BROWSER_EXECUTABLE ||
      ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("blattbot.paneLeft.v2", "chat");
    localStorage.setItem("blattbot.paneRight.v2", "source");
    localStorage.setItem("blattbot.sourceAutosave", "0");
  });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open Turn Flow Fixture" }).click();
  const left = page.locator('[data-pane="left"]');
  const right = page.locator('[data-pane="right"]');
  const input = page.getByRole("textbox", { name: "Message BlattBot", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const queued = page.getByRole("region", { name: "Queued messages" });
  await input.waitFor();

  // ---- 1. A held turn; the composer stays usable and queues ----------------
  await input.fill("Rewrite the intro [hold]");
  await input.press("Enter");
  await stop.waitFor();
  await waitUntil("held request", () => held());
  assert(await input.isEnabled(), "the composer stays enabled during a turn");
  await input.fill("Second message");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await queued.getByText("Second message").waitFor();
  await input.fill("Third message");
  await input.press("Enter");
  await queued.getByText("Third message").waitFor();
  assert.equal(await left.getByText("Second message").count(), 1, "a queued message is not a chat bubble yet");
  await queued.getByRole("button", { name: "Remove queued message 2" }).click();
  await waitUntil("removed from queue", async () => (await queued.getByText("Third message").count()) === 0);

  // ---- 2. The Source editor takes a draft during the turn ------------------
  await right.getByRole("button", { name: "references.bib" }).click();
  await right.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("% drafted during the turn\n");
  const saveButton = right.getByRole("button", { name: "Saves after the turn" });
  await saveButton.waitFor();
  await saveButton.click();
  await right.getByText("saves after the turn", { exact: true }).waitFor();
  await shot("01-typing-and-queue-during-turn");

  // ---- 3. The turn ends: card, queued message starts, draft is saved ------
  release!();
  const card = left.locator("[data-turn-card]").first();
  await card.waitFor({ timeout: 20_000 });
  await card.getByText("1 file", { exact: true }).waitFor();
  assert.equal((await card.innerText()).includes("+1"), true, "the card counts added lines");
  await left.getByText("Answered: Second message").waitFor({ timeout: 20_000 });
  assert.deepEqual(prompts.slice(0, 2).map((p) => p.split("\n")[0]), ["Rewrite the intro [hold]", "Second message"]);
  await waitUntil("deferred save", async () => (await fileText("references.bib")).includes("% drafted during the turn"));
  await right.getByRole("button", { name: "Save", exact: true }).waitFor();
  await waitUntil("queue drained", async () => (await queued.count()) === 0);
  await shot("02-turn-card");

  // ---- 4. Show changes, Undo turn, and undo the undo -----------------------
  await card.getByRole("button", { name: "Show changes" }).click();
  const changes = card.getByRole("region", { name: "Changes of this turn" });
  await changes.getByText("The agent rewrote the introduction.").waitFor();
  await card.getByRole("button", { name: "Hide changes" }).click();
  await card.getByRole("button", { name: "Undo turn" }).click();
  const confirm = page.getByRole("dialog", { name: "Undo this turn?" });
  await confirm.waitFor();
  await shot("03-undo-confirm");
  await confirm.getByRole("button", { name: "Undo turn" }).click();
  await card.getByText("undone", { exact: true }).waitFor();
  await waitUntil("turn undone on disk", async () => (await fileText("main.tex")) === originalMain);
  const toast = page.getByRole("status", { name: "Undo" });
  await toast.getByText("Turn undone.").waitFor();
  await shot("04-turn-undone-toast");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await waitUntil("undo undone", async () => (await fileText("main.tex")).includes("The agent rewrote the introduction."));
  // The card can undo the turn again; the chat says it is back.
  await card.getByRole("button", { name: "Undo turn" }).waitFor();
  await left.getByText(/^Turn restored: 1 file put back/).waitFor();

  // ---- 5. Discard with the Undo toast, then Restore last discard -----------
  await card.getByRole("button", { name: "Review" }).click();
  await right.getByRole("button", { name: "Discard", exact: true }).waitFor();
  await right.getByRole("button", { name: "Discard", exact: true }).click();
  await right.getByRole("button", { name: "Really discard?" }).click();
  await toast.getByText("Discarded all pending changes.").waitFor();
  await waitUntil("discarded", async () => (await fileText("main.tex")) === originalMain);
  await shot("05-discard-toast");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await waitUntil("discard undone", async () => (await fileText("main.tex")).includes("The agent rewrote the introduction."));
  await right.getByRole("button", { name: "Discard", exact: true }).click();
  await right.getByRole("button", { name: "Really discard?" }).click();
  await toast.getByText("Discarded all pending changes.").waitFor();
  await toast.getByRole("button", { name: "Dismiss" }).click();
  const restore = right.getByRole("button", { name: "Restore last discard" });
  await restore.waitFor();
  await shot("06-restore-last-discard");
  await restore.click();
  await waitUntil("restored", async () => (await fileText("main.tex")).includes("The agent rewrote the introduction."));
  await restore.waitFor({ state: "detached" });

  // ---- 6. A failed turn pauses the queue until Resume ----------------------
  await input.fill("Break [hold] [error]");
  await input.press("Enter");
  await stop.waitFor();
  await waitUntil("held failing request", () => held());
  await input.fill("After the failure");
  await input.press("Enter");
  await queued.getByText("After the failure").waitFor();
  release!();
  await queued.getByText(/Queue paused/).waitFor({ timeout: 20_000 });
  assert.equal(prompts.filter((p) => p.startsWith("After the failure")).length, 0, "a paused queue starts nothing");
  await shot("07-queue-paused");
  await queued.getByRole("button", { name: "Resume" }).click();
  await left.getByText("Answered: After the failure").waitFor({ timeout: 20_000 });

  assert.deepEqual(errors, []);
  console.log(
    "Turn flow passed: typing and queueing during a turn, queue removal, Source draft saved after the turn, turn-end card, " +
      `Show changes, Undo turn + its undo, discard + Undo toast, Restore last discard, paused queue + Resume. Screenshots: ${SHOTS}`,
  );
} catch (err) {
  console.error(logs.slice(-4000));
  throw err;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => (server.exitCode !== null ? resolve(undefined) : server.once("exit", resolve)));
  model.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10 });
}
