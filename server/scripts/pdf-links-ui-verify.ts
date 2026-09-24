/** Real browser/PDF.js navigation with a deterministic annotated PDF, no TeX or model needed. */
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { referencePdf } from "../test/fixtures/pdf-links.js";

const root = mkdtempSync(join(tmpdir(), "blattbot-pdf-links-"));
const shots = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-pdf-links";
mkdirSync(shots, { recursive: true });
process.env.BLATTBOT_DATA_DIR = join(root, "data");
const cfg = await import("../src/config.js");
const project = cfg.addProject({ name: "PDF References Fixture", kind: "local", gitUrl: "", mainTex: "main.tex" });
const dir = cfg.projectDir(project.id); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}Reference fixture.\\end{document}\n");
writeFileSync(join(dir, "refs.bib"), "@article{example, title={Example reference}, author={Example, Author}, year={2026}}\n");
execFileSync("git", ["-C", dir, "init", "-b", "main"], { stdio: "pipe" });
execFileSync("git", ["-C", dir, "add", "."]);
execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-m", "Fixture"], { stdio: "pipe" });
const port = 4594, base = `http://127.0.0.1:${port}`;
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("blattbot.paneLeft.v2", "chat"); localStorage.setItem("blattbot.paneRight.v2", "pdf"); });
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, lastCompile: { ok: true, hasPdf: true, engine: "fixture", durationMs: 1, errors: [], warnings: [], logTail: "" } } });
  });
  await page.route(`**/api/projects/${project.id}/pdf?*`, route => route.fulfill({ contentType: "application/pdf", body: referencePdf() }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open PDF References Fixture" }).click();
  const equation = page.getByRole("button", { name: "Jump to PDF reference equation.6", exact: true });
  const back = page.getByRole("button", { name: "Jump to PDF reference section.method", exact: true });
  const landed = async (pageNo: number, y: number) => page.waitForFunction(({ pageNo, y }) => {
    const container = document.querySelector<HTMLElement>("[data-pdf-scroll]");
    const holder = container?.querySelector<HTMLElement>(`[data-pdf-page="${pageNo}"]`);
    if (!holder || !container) return false;
    const rect = holder.getBoundingClientRect();
    return Math.abs(rect.top + (792 - y) / 612 * rect.width - container.getBoundingClientRect().top - 48) < 3;
  }, { pageNo, y });
  await equation.click(); await landed(4, 400);
  await page.screenshot({ path: join(shots, "01-equation-destination.png"), fullPage: true });
  await back.click(); await landed(1, 700);
  await page.getByRole("button", { name: "Jump to PDF reference 2", exact: true }).click(); await landed(1, 300);
  await equation.focus(); await equation.press("Enter"); await landed(4, 400);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click(); await landed(4, 400);
  await page.setViewportSize({ width: 1300, height: 900 }); await landed(4, 400);
  await back.click(); await landed(1, 700);
  const citation = page.getByRole("button", { name: "Citation example — jump to bibliography", exact: true });
  await citation.hover();
  await page.getByRole("button", { name: "Open in References", exact: true }).waitFor();
  await citation.click();
  await page.waitForFunction(() => {
    const container = document.querySelector<HTMLElement>("[data-pdf-scroll]")!;
    const rect = container.querySelector<HTMLElement>('[data-pdf-page="5"]')!.getBoundingClientRect();
    const y = rect.top + (792 - 500) / 612 * rect.width;
    const bounds = container.getBoundingClientRect();
    return y > bounds.top && y < bounds.bottom;
  });
  await page.getByRole("button", { name: "Jump to PDF reference missing", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "destination could not be found" }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`PDF reference navigation passed (named, explicit, same-page, distant, keyboard, zoom, resize, citation, broken links); screenshot: ${shots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM"); await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
