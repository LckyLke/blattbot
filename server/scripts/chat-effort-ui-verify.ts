/** Exercise the chat selector against the real settings API without running a model. */
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "blattbot-chat-effort-"));
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const config = await import("../src/config.js");
const settings = await import("../src/settings.js");
settings.saveSettings({ backend: "codex", codexModel: "fixture-codex", codexEffort: "" });
const project = config.addProject({ name: "Chat Effort Fixture", kind: "local", gitUrl: "", mainTex: "main.tex" });
const dir = config.projectDir(project.id); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}Fixture\\end{document}\n");
execFileSync("git", ["-C", dir, "init", "-b", "main"], { stdio: "pipe" });
execFileSync("git", ["-C", dir, "add", "."]);
execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-m", "Fixture"], { stdio: "pipe" });
const chats = await import("../src/chats.js");
const chat = chats.ensureActiveChat(project.id);
chats.appendEvent(project.id, chat.id, { type: "tool_use", id: "verify-fixture", name: "mcp__blattbot__verify_citation_support", detail: "smith2025", input: JSON.stringify({ key: "smith2025", claim: "The exact claim being verified." }) });
chats.appendEvent(project.id, chat.id, { type: "tool_result", id: "verify-fixture", output: "SUPPORTED\nEvidence: page 4, the reported experiment.", isError: false });
const port = 4595, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(port) }, stdio: "pipe",
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
  const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem("blattbot.paneLeft.v2", "chat"); localStorage.setItem("blattbot.paneRight.v2", "source"); });
  await page.route("**/api/models**", async route => {
    const backend = new URL(route.request().url()).searchParams.get("backend") || "codex";
    await route.fulfill({ json: { backend, source: "cli", defaultModel: "fixture-codex", models: [
      { id: "fixture-codex", label: "Fixture Codex", supportsEffort: true, effortLevels: ["low", "high", "ultra"] },
      { id: "fixture-limited", label: "Limited effort", supportsEffort: true, effortLevels: ["low"] },
      { id: "claude-sonnet-5", label: "Claude", supportsEffort: true, effortLevels: ["low", "high", "max"] },
    ] } });
  });
  await page.route("**/api/agent/codex/limits", route => route.fulfill({ json: {
    windows: [{ bucket: "codex", window: "5 hour", remainingPercent: 75, resetsAt: 1800000000 }],
    checkedAt: Date.now(),
  } }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open Chat Effort Fixture" }).click();
  await page.getByRole("button", { name: "Usage limits", exact: true }).click();
  await page.getByText("75% remaining", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-composer-toolbar").getByRole("button", { name: "Usage limits", exact: true }).count(), 1);
  await page.screenshot({ path: "/tmp/blattbot-usage-popover.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("region", { name: "Usage limits details" }).count(), 0);
  const details = page.getByRole("button", { name: "Show tool details", exact: true }).first();
  await details.click();
  await page.getByText("SUPPORTED", { exact: false }).waitFor();
  assert((await page.locator("pre").allTextContents()).some(text => text.includes("The exact claim being verified.")));
  await page.getByRole("button", { name: "Hide tool details", exact: true }).first().click();
  const effort = page.getByRole("combobox", { name: "Reasoning effort", exact: true });
  const savedSettings = async () => (await page.request.get(base + "/api/settings")).json();
  const choose = async (value: string) => {
    const saved = page.waitForResponse(r => r.url() === base + "/api/settings" && r.request().method() === "PUT");
    await effort.selectOption(value); await saved;
    await page.waitForFunction(value => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]');
      return select?.value === value && !select.disabled;
    }, value);
  };
  await effort.locator('option[value="ultra"]').waitFor({ state: "attached" });
  assert.deepEqual(await effort.locator("option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value)), ["", "low", "high", "ultra"]);
  await choose("high"); assert.equal((await savedSettings()).codexEffort, "high");
  await page.reload({ waitUntil: "networkidle" });
  await effort.waitFor(); assert.equal(await effort.inputValue(), "high");
  const composer = page.getByRole("form", { name: "Chat composer", exact: true });
  const input = page.getByRole("textbox", { name: "Message BlattBot", exact: true });
  const mode = page.getByRole("combobox", { name: "Chat mode", exact: true });
  assert.equal(await mode.locator("option").count(), 6);
  await mode.selectOption("research");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await mode.inputValue(), "research");
  await mode.selectOption("edit");
  assert(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
  await input.fill("Help me tighten the methodology section.");
  await input.press("Shift+Enter");
  await input.pressSequentially("Keep the equations and citations intact.");
  assert((await input.inputValue()).includes("\n"));
  assert(await page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  await page.screenshot({ path: "/tmp/blattbot-chat-effort.png", fullPage: true });
  await composer.screenshot({ path: "/tmp/blattbot-composer.png" });
  await input.fill("A longer paragraph to check wrapping and resizing. ".repeat(30));
  assert((await input.boundingBox())!.height <= 201);
  await input.fill("");
  assert((await input.boundingBox())!.height <= 80);
  await page.setViewportSize({ width: 1050, height: 850 });
  assert(await composer.evaluate(el => el.scrollWidth <= el.clientWidth), "Composer must fit a narrow pane");
  const usageRect = await composer.getByRole("button", { name: "Usage limits", exact: true }).boundingBox();
  const sendRect = await composer.getByRole("button", { name: "Send", exact: true }).boundingBox();
  assert(usageRect && sendRect && usageRect.x + usageRect.width <= sendRect.x, "Usage control must not overlap Send at narrow widths");
  await composer.screenshot({ path: "/tmp/blattbot-composer-narrow.png" });
  await page.setViewportSize({ width: 1450, height: 1000 });
  // Failed writes leave the persisted choice visible and expose the server error.
  await page.route("**/api/settings", async route => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 500, json: { error: "Fixture save failure" } });
    else await route.continue();
  });
  await effort.selectOption("ultra");
  await page.getByText("Fixture save failure", { exact: false }).waitFor();
  assert.equal(await effort.inputValue(), "high");
  await page.unroute("**/api/settings");
  // Effort choices follow the project's effective model, including overrides.
  const overridden = await page.request.put(`${base}/api/projects/${project.id}/settings`, { data: { model: "fixture-limited" } });
  assert(overridden.ok()); await page.reload({ waitUntil: "networkidle" });
  await effort.locator('option[value="high"][disabled]').waitFor({ state: "attached" });
  assert.equal(await effort.locator('option[value="ultra"]').count(), 0);
  await choose("low"); assert.equal((await savedSettings()).codexEffort, "low");
  await choose(""); assert.equal((await savedSettings()).codexEffort, "");
  await page.request.put(`${base}/api/projects/${project.id}/settings`, { data: { model: "" } });
  await page.request.put(base + "/api/settings", { data: { backend: "claude", model: "claude-sonnet-5", effort: "" } });
  await page.reload({ waitUntil: "networkidle" });
  await effort.locator('option[value="max"]').waitFor({ state: "attached" });
  await choose("max"); assert.equal((await savedSettings()).effort, "max");
  assert.equal((await savedSettings()).codexEffort, "");
  await page.request.put(base + "/api/settings", { data: { backend: "openai", openaiModel: "fixture" } });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await effort.count(), 0);
  assert.deepEqual(errors, []);
  console.log("Chat usage limits, expandable citation evidence, and reasoning effort passed: catalog levels, save/reload, failed save, project override, defaults, Codex/Claude isolation, unsupported backend.");
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
