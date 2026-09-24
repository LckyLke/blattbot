/** Real browser/PDF.js navigation with a deterministic annotated PDF, no TeX or model needed. */
import { chromium, type WebSocketRoute } from "playwright-core";
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
  let socket: WebSocketRoute;
  let version = 1, pdfRequests = 0, compileRequests = 0, detailRequests = 0;
  let pdfBytes = referencePdf();
  const compileInfo = () => ({ ok: true, hasPdf: true, pdfVersion: `fixture-${version}`, engine: "fixture", durationMs: 1, errors: [], warnings: [], logTail: "" });
  await page.routeWebSocket("**/api/ws?*", ws => { socket = ws; });
  await page.addInitScript(() => { localStorage.setItem("blattbot.paneLeft.v2", "chat"); localStorage.setItem("blattbot.paneRight.v2", "pdf"); });
  await page.route(`**/api/projects/${project.id}`, async route => {
    detailRequests++;
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, lastCompile: compileInfo() } });
  });
  await page.route(`**/api/projects/${project.id}/pdf?*`, async route => {
    pdfRequests++;
    await route.fulfill({ contentType: "application/pdf", body: pdfBytes });
  });
  await page.route(`**/api/projects/${project.id}/compile`, async route => {
    compileRequests++; version++;
    socket.send(JSON.stringify({ type: "compile_start" }));
    socket.send(JSON.stringify({ type: "compile", ...compileInfo() }));
    await route.fulfill({ json: compileInfo() });
  });
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

  // A reading position is independent of reference navigation, zoom, and PDF instances.
  const readPosition = () => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>("[data-pdf-scroll]")!;
    const page = [...container.querySelectorAll<HTMLElement>("[data-pdf-page]")].find(p => p.getBoundingClientRect().bottom > container.getBoundingClientRect().top)!;
    const rect = page.getBoundingClientRect();
    return { page: Number(page.dataset.pdfPage), offset: (container.getBoundingClientRect().top - rect.top) / rect.width };
  });
  await page.locator("[data-pdf-scroll]").evaluate(container => {
    container.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    const holder = container.querySelector<HTMLElement>('[data-pdf-page="4"]')!;
    container.scrollTop += holder.getBoundingClientRect().top - container.getBoundingClientRect().top + holder.clientWidth * 0.25;
  });
  await page.waitForFunction(() => {
    const stored = Object.keys(sessionStorage).find(k => k.startsWith("blattbot.pdfPosition:"));
    return stored && JSON.parse(sessionStorage.getItem(stored)!).page === 4;
  });
  let bookmark = await readPosition();
  const samePosition = async () => page.waitForFunction(expected => {
    const container = document.querySelector<HTMLElement>("[data-pdf-scroll]");
    const holder = container?.querySelector<HTMLElement>(`[data-pdf-page="${expected.page}"]`);
    if (!container?.clientWidth || !holder) return false;
    const rect = holder.getBoundingClientRect();
    return Math.abs((container.getBoundingClientRect().top - rect.top) / rect.width - expected.offset) < 0.004;
  }, bookmark);
  const loaded = pdfRequests;
  await page.getByRole("tab", { name: "Source", exact: true }).last().click();
  await page.getByRole("tab", { name: "PDF", exact: true }).last().click();
  await samePosition(); assert.equal(pdfRequests, loaded, "Tab switching must reuse the loaded PDF");
  const refreshes = detailRequests;
  socket!.send(JSON.stringify({ type: "turn_start" }));
  socket!.send(JSON.stringify({ type: "turn_end", durationMs: 1 }));
  socket!.send(JSON.stringify({ type: "diff", diff: "", changed: false }));
  await page.waitForResponse(response => response.url() === `${base}/api/projects/${project.id}`);
  await samePosition(); assert(detailRequests > refreshes);
  assert.equal(pdfRequests, loaded, "A read-only turn must not reload the PDF");
  await page.getByRole("tab", { name: "Source", exact: true }).last().click();
  await page.getByRole("tab", { name: "PDF", exact: true }).last().click();
  await samePosition(); assert.equal(compileRequests, 0, "A read-only turn must not mark the preview dirty");
  const documentId = () => page.locator("[data-pdf-scroll]").getAttribute("data-pdf-document");
  const replaced = (previous: string | null) => page.waitForFunction(previous => {
    const current = document.querySelector<HTMLElement>("[data-pdf-scroll]")?.dataset.pdfDocument;
    return current && current !== previous;
  }, previous);
  let previousDoc = await documentId();
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await replaced(previousDoc);
  await samePosition(); assert.equal(pdfRequests, loaded + 1);
  // Agent-initiated compile while Source is visible must restore on returning.
  await page.getByRole("tab", { name: "Source", exact: true }).last().click();
  previousDoc = await documentId();
  version++;
  socket!.send(JSON.stringify({ type: "compile", ...compileInfo() }));
  await replaced(previousDoc);
  await page.getByRole("tab", { name: "PDF", exact: true }).last().click();
  await samePosition();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click(); await samePosition();
  await page.setViewportSize({ width: 1500, height: 1000 }); await samePosition();
  // A real Source save followed by returning to PDF must compile in place.
  await page.getByRole("tab", { name: "Source", exact: true }).last().click();
  const editor = page.locator("#pane-panel-source .cm-content");
  await editor.click(); await editor.press("Control+End");
  await page.keyboard.insertText("\n% manual edit for reading-position regression\n");
  const saved = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/file`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Save", exact: true }).click(); await saved;
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  previousDoc = await documentId();
  await page.getByRole("tab", { name: "PDF", exact: true }).last().click();
  await replaced(previousDoc); await samePosition();
  assert.equal(compileRequests, 2, "Saving Source should compile when returning to PDF");
  await page.reload({ waitUntil: "networkidle" });
  await samePosition();
  // An edit before the passage changes pagination: follow its text onto page 3.
  previousDoc = await documentId();
  pdfBytes = referencePdf(3); version++;
  socket!.send(JSON.stringify({ type: "compile", ...compileInfo() }));
  await replaced(previousDoc);
  bookmark = { ...bookmark, page: 3 };
  await samePosition();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`PDF navigation and reading position passed (links, tabs, read-only turns, manual edits, recompiles, hidden compile, zoom, resize, reload, moved passages); screenshot: ${shots}`);
} finally {
  await browser?.close();
  server.kill("SIGTERM"); await new Promise(resolve => { if (server.exitCode !== null) resolve(undefined); else server.once("exit", resolve); });
  rmSync(root, { recursive: true, force: true });
}
