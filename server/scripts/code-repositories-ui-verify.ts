/** Real browser → agent tools → Git snapshots → stored evidence. Fixture model, no paid calls. */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "blattbot-code-ui-"));
const data = join(root, "data");
const source = join(root, "implementation");
const shots = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-code-ui";
mkdirSync(shots, { recursive: true });
const port = 4592, modelPort = 4593, base = `http://127.0.0.1:${port}`;
const quote = "We use the mean loss over the batch.";
let repository: { id: string; commit: string };
const toolNames: string[] = [];
let judgeCalled = false;
const model = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.stream) {
      const prompt = body.messages.map((m: any) => m.content).join("\n");
      let content = "Fixture helper response";
      if (prompt.includes("Assess ONE manuscript claim")) {
        assert(prompt.includes(repository.commit));
        assert(prompt.includes("return x.sum()"));
        judgeCalled = true;
        content = JSON.stringify({ claimKind: "implementation", verdict: "contradicted", explanation: "The manuscript says mean, but the implementation sums the batch.",
          evidence: [{ index: 0, quote: "return x.sum()" }], limitations: ["Only the supplied implementation was inspected; the active call site is not established."], nextChecks: ["Check callers for a later normalization step."] });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    const toolResults = body.messages.filter((m: any) => m.role === "tool");
    const calls = [
      { name: "inspect_repository", arguments: { action: "list" } },
      { name: "read_file", arguments: { path: "main.tex" } },
      { name: "inspect_repository", arguments: { action: "search", repositoryId: repository.id, commit: repository.commit, query: "sum" } },
      { name: "inspect_repository", arguments: { action: "read", repositoryId: repository.id, commit: repository.commit, path: "loss.py", startLine: 1, endLine: 2 } },
      { name: "verify_code_claim", arguments: { file: "main.tex", quote, claimKind: "implementation", evidence: [{ repositoryId: repository.id, commit: repository.commit, path: "loss.py", startLine: 1, endLine: 2, role: "counterevidence" }] } },
    ];
    const step = toolResults.length;
    if (step > 0) assert(!String(toolResults.at(-1).content).startsWith("Error:"), toolResults.at(-1).content);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const call = calls[step];
    if (call) {
      assert(body.tools.some((t: any) => t.function.name === call.name));
      assert(!body.tools.some((t: any) => t.function.name === "write_file"), "Audit should use read-only mode");
      toolNames.push(call.name);
      emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: `code-tool-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: "tool_calls" }] });
    } else {
      assert(String(toolResults.at(-1).content).includes("contradicted"));
      emit({ choices: [{ delta: { content: "Saved a code assessment: the paper claims mean reduction, while loss.py sums the batch. The call site remains unchecked." }, finish_reason: "stop" }] });
    }
    res.end("data: [DONE]\n\n");
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise<void>(resolve => model.listen(modelPort, "127.0.0.1", resolve));
process.env.BLATTBOT_DATA_DIR = data;
const cfg = await import("../src/config.js");
const project = cfg.addProject({ name: "Code Verification Fixture", kind: "local", gitUrl: "", mainTex: "main.tex" });
const manuscriptDir = cfg.projectDir(project.id);
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
for (const dir of [source, manuscriptDir]) {
  mkdirSync(dir, { recursive: true }); git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "fixture@example.org"); git(dir, "config", "user.name", "Fixture");
}
writeFileSync(join(source, "loss.py"), "def loss(x):\n    return x.sum()\n");
writeFileSync(join(manuscriptDir, "main.tex"), `\\documentclass{article}\n\\begin{document}\n${quote}\n\\end{document}\n`);
for (const dir of [source, manuscriptDir]) { git(dir, "add", "."); git(dir, "commit", "-m", "Fixture"); }
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(port), BLATTBOT_DATA_DIR: data }, stdio: "pipe",
});
let logs = "", token = "";
server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function api(path: string, body?: unknown, method = "POST") {
  const res = await fetch(base + path, { method: body === undefined ? "GET" : method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert(res.ok, `${res.status} ${path}: ${res.ok ? "" : await res.text()}`);
  return res.json() as Promise<any>;
}
try {
  for (let i = 0; i < 100; i++) {
    try { token = (await (await fetch(base + "/api/bootstrap")).json() as any).token; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(token, logs);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/research/repositories`)).status, 401);
  await api("/api/settings", { backend: "openai", openaiBaseUrl: `http://127.0.0.1:${modelPort}/v1`, openaiModel: "fixture-code-assessor" }, "PUT");
  browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem("blattbot.paneLeft.v2", "chat"); localStorage.setItem("blattbot.paneRight.v2", "research"); });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open Code Verification Fixture" }).click();
  const research = page.locator(".research-panel:not(.cg-portal-root)").filter({ visible: true });
  await research.getByRole("button", { name: "Checks", exact: true }).click();
  const checks = research.locator("section").filter({ has: page.getByRole("heading", { name: "Verify claims against code" }) });
  assert(await checks.getByRole("button", { name: "Check manuscript against code" }).isDisabled());
  await checks.getByRole("button", { name: "Add repository", exact: true }).click();
  await checks.getByRole("button", { name: "Local folder", exact: true }).click();
  await checks.getByRole("button", { name: "Browse folders…", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a local Git repository" });
  await picker.getByLabel("Folder location").fill(root);
  await picker.getByRole("button", { name: "Go", exact: true }).click();
  const folder = picker.getByRole("button", { name: "Open folder implementation", exact: true });
  await folder.waitFor();
  assert(await picker.getByRole("button", { name: "Use this repository" }).isDisabled());
  assert(await folder.getByText("Git", { exact: true }).isVisible());
  await picker.getByLabel("Filter folders").fill("implementation");
  await folder.click();
  await picker.getByText("Git repository found", { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "00-local-repository-picker.png"), fullPage: true });
  await picker.getByRole("button", { name: "Use this repository" }).click();
  await picker.waitFor({ state: "detached" });
  assert.equal(await checks.getByLabel("Branch, tag or commit").inputValue(), "main");
  const changeFolder = checks.getByRole("button", { name: "Change folder…", exact: true });
  await changeFolder.click();
  await picker.getByText("Git repository found", { exact: true }).waitFor();
  assert.equal(await picker.getByLabel("Folder location").inputValue(), source);
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });
  assert(await changeFolder.evaluate(element => element === document.activeElement));
  await checks.getByRole("button", { name: "Attach snapshot" }).click();
  await checks.getByRole("button", { name: "Refresh revision" }).waitFor();
  [repository] = await api(`/api/projects/${project.id}/research/repositories`);
  assert.equal(repository.commit, git(source, "rev-parse", "HEAD"));
  await checks.getByLabel("What should the agent check?").fill("Check the loss reduction against loss.py and save the evidence.");
  await checks.getByRole("button", { name: "Check manuscript against code" }).click();
  await checks.getByText("Contradiction found", { exact: true }).waitFor({ timeout: 30_000 });
  assert(judgeCalled); assert.deepEqual(toolNames, ["inspect_repository", "read_file", "inspect_repository", "inspect_repository", "verify_code_claim"]);
  await checks.locator("summary").filter({ hasText: "Contradiction found" }).click();
  await checks.getByText("loss.py:2", { exact: true }).waitFor();
  assert.equal(git(manuscriptDir, "status", "--porcelain"), "");
  const downloadReady = page.waitForEvent("download");
  await checks.getByRole("button", { name: "Export evidence" }).click();
  const download = await downloadReady;
  const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
  assert.equal(exported.assessments[0].inputs[0].commit, repository.commit);
  await page.screenshot({ path: join(shots, "01-code-evidence.png"), fullPage: true });
  writeFileSync(join(source, "loss.py"), "def loss(x):\n    return x.mean()\n"); git(source, "add", "."); git(source, "commit", "-m", "Change reduction");
  await checks.getByRole("button", { name: "Refresh revision" }).click();
  await checks.getByText("Changed · check again", { exact: true }).waitFor();
  const oldRead = await api(`/api/projects/${project.id}/research/repositories/inspect`, { action: "read", repositoryId: repository.id, commit: repository.commit, path: "loss.py" });
  assert(oldRead.content.includes("x.sum()"));
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.screenshot({ path: join(shots, "02-stale-code-evidence.png"), fullPage: true });
  await checks.getByRole("button", { name: "Remove", exact: true }).click();
  await checks.getByRole("button", { name: "Refresh revision" }).waitFor({ state: "detached" });
  assert.deepEqual(await api(`/api/projects/${project.id}/research/repositories`), []);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`Code repository browser workflow passed; screenshots: ${shots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM"); await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  await new Promise<void>(resolve => model.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
