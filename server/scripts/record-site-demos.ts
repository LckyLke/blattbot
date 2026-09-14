/** Record real UI walkthroughs against site-demo-project's isolated, prepared data.
 * DEMO_CLIP=evidence|graph|writing records one clip; default records all three.
 * DEMO_OUT_DIR changes the output folder. Run site-demo-project.ts --prepare first.
 * Captions and the pointer are presentation overlays; app state comes from real APIs.
 */
import { chromium, type Page, type Locator } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoRoot, project, projectPath, manuscript } from "./site-demo-project.js";

const out = process.env.DEMO_OUT_DIR ?? join(demoRoot, "recordings");
mkdirSync(out, { recursive: true });
const port = 4638;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, BLATTBOT_PORT: String(port), BLATTBOT_DATA_DIR: demoRoot }, stdio: "pipe",
});
let logs = "";
server.stdout?.on("data", c => { logs += c; });
server.stderr?.on("data", c => { logs += c; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let token = "";
const api = async (suffix: string, body?: unknown, method = "POST") => {
  const response = await fetch(`${base}/api/projects/${project.id}${suffix}`, { method: body === undefined ? "GET" : method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${suffix}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
};
async function point(page: Page, locator: Locator) {
  await locator.first().scrollIntoViewIfNeeded();
  const bounds = await locator.first().boundingBox();
  if (bounds) await page.evaluate(({ x, y }) => {
    const pointer = document.getElementById("demo-pointer")!;
    pointer.style.left = `${x}px`; pointer.style.top = `${y}px`;
  }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  await page.waitForTimeout(450);
}
async function click(page: Page, locator: Locator) {
  await locator.first().waitFor();
  await point(page, locator);
  // Dispatch works for both HTML controls and SVG graph nodes.
  await locator.first().evaluate(el => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(650);
}
async function type(page: Page, locator: Locator, value: string) {
  await point(page, locator);
  await locator.first().focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(value, { delay: 65 });
  await page.waitForTimeout(650);
  if (await locator.first().inputValue() !== value) throw new Error(`Typing did not preserve the query: ${value}`);
}
const tab = (page: Page, side: "left" | "right", name: string) => page.locator(`[data-pane="${side}"]`).getByRole("tab", { name, exact: true });
try {
  for (let i = 0; i < 100; i++) {
    try { token = ((await (await fetch(`${base}/api/bootstrap`)).json()) as any).token; if (token) break; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (!token) throw new Error(`Server failed: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE ?? "/usr/bin/chromium", headless: true });
  const clips = process.env.DEMO_CLIP ? [process.env.DEMO_CLIP] : ["evidence", "graph", "writing"];
  for (const clip of clips) {
    if (!["evidence", "graph", "writing"].includes(clip)) throw new Error("Unknown clip");
    writeFileSync(join(projectPath, "main.tex"), manuscript);
    await api("/compile", {});
    await api("/research/policy", { strict: false }, "PUT");
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: out, size: { width: 1600, height: 1000 } } });
    await context.addInitScript(({ clip }) => {
      localStorage.setItem("blattbot.paneLeft.v2", clip === "writing" ? "source" : "pdf");
      localStorage.setItem("blattbot.paneRight.v2", clip === "writing" ? "pdf" : "research");
      localStorage.setItem("blattbot.panelWidth", clip === "writing" ? "540" : "690");
      localStorage.setItem("blattbot.sourceWrap", "1");
    }, { clip });
    const page = await context.newPage();
    const started = Date.now();
    const marks: { at: number; text: string }[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: `Open ${project.name}`, exact: true }).evaluate(el => (el as HTMLElement).click());
    await page.locator(".textLayer").first().waitFor({ timeout: 60000 });
    await page.addStyleTag({ content: `
      #demo-pointer { position: fixed; width: 15px; height: 15px; border: 2px solid #cfa75b; background: #cfa75b45; border-radius: 50%; z-index: 99999; pointer-events: none; left: -50px; top: -50px; transition: left .4s ease, top .4s ease; box-shadow: 0 0 0 4px #cfa75b18; }
      #demo-caption { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 99998; pointer-events: none; padding: 12px 22px; border: 1px solid #4f7942; background: #12151df5; border-radius: 8px; color: #e8e4d8; font: 500 17px/1.5 'IBM Plex Sans', sans-serif; box-shadow: 0 8px 32px #0008; white-space: nowrap; }
      #demo-caption span { color: #8fb573; margin-right: 14px; font: 12px 'IBM Plex Mono', monospace; }
    ` });
    await page.evaluate(() => {
      for (const id of ["demo-pointer", "demo-caption"]) { const el = document.createElement("div"); el.id = id; document.body.append(el); }
    });
    const caption = async (text: string) => {
      marks.push({ at: (Date.now() - started) / 1000, text });
      await page.evaluate(({ clip, text }) => { const el = document.getElementById("demo-caption")!; el.replaceChildren(); const tag = document.createElement("span"); tag.textContent = clip === "evidence" ? "READ & VERIFY" : clip === "graph" ? "CONNECT YOUR SOURCES" : "FIND & REFINE"; el.append(tag, text); }, { clip, text });
      console.log(`${clip}: ${text}`);
    };
    const shot = async (name: string) => {
      await page.screenshot({ path: join(out, `${name}.png`) });
    };
    const research = page.locator(".research-panel").filter({ visible: true });
    if (clip === "evidence") {
      await click(page, research.getByRole("button", { name: "Evidence", exact: true }));
      await research.getByText("Supports claim", { exact: true }).first().waitFor();
      await research.locator(".research-body").evaluate(el => { el.scrollTop = 0; }).catch(() => {});
      await caption("Follow the claim back to its source.");
      await page.waitForTimeout(2200);
      const card = research.locator("article.research-card").filter({ has: page.getByText("devlin2019", { exact: true }) });
      await click(page, card.getByText("Evidence & explanation", { exact: true }));
      await caption("A quoted passage. A page number. A checkable assessment.");
      await point(page, card.locator("blockquote"));
      await shot("research-evidence");
      await page.waitForTimeout(2800);
      await click(page, card.getByRole("button", { name: /Open source · page/ }).first());
      await research.getByRole("region", { name: "Original source passage" }).waitFor();
      await caption("Read the original evidence in context.");
      await page.waitForTimeout(3500);
      await click(page, research.getByRole("button", { name: "Close source" }));
      await click(page, research.getByRole("button", { name: "Library", exact: true }));
      await caption("Search across the papers in your project.");
      await type(page, research.getByLabel("Search the paper library", { exact: true }), "bidirectional");
      await click(page, research.getByRole("button", { name: "Search papers", exact: true }));
      await research.locator("blockquote").first().waitFor();
      await page.waitForTimeout(3300);
      await click(page, research.getByRole("button", { name: "Evidence", exact: true }));
      await click(page, research.getByLabel("Strict mode — resolve evidence gaps before approval"));
      await caption("Keep unresolved passages open before approval.");
      await page.waitForTimeout(2800);
    } else if (clip === "graph") {
      await research.getByRole("group", { name: "Interactive directed citation graph" }).waitFor();
      await caption("Your papers connect to a wider literature.");
      await page.waitForTimeout(2500);
      await shot("research-graph");
      await click(page, research.getByLabel("Project only", { exact: true }));
      await caption("Start with the sources already in your project.");
      await page.waitForTimeout(2400);
      await click(page, research.getByLabel("Project only", { exact: true }));
      await click(page, research.getByRole("button", { name: /Project source: BERT:/ }).first());
      await caption("Select a paper to inspect its connections.");
      await page.waitForTimeout(2800);
      await click(page, research.getByRole("button", { name: "Close paper details" }));
      await click(page, research.getByRole("button", { name: "Find missing sources", exact: true }));
      await caption("Discover references your bibliography is missing.");
      await research.getByText(/Cited by [23] project papers:/).first().waitFor();
      await point(page, research.getByText(/Cited by [23] project papers:/).first());
      await page.waitForTimeout(3000);
      await click(page, research.getByRole("button", { name: "Close query results" }));
      await click(page, research.getByText("Compare two papers", { exact: true }));
      await click(page, research.getByRole("button", { name: "Find shared references", exact: true }));
      await caption("Compare the references two papers share.");
      await page.waitForTimeout(3500);
    } else {
      await page.locator(".cm-content").waitFor();
      await caption("Your LaTeX and its PDF, side by side.");
      await page.waitForTimeout(2100);
      await page.locator(".cm-content").focus();
      await page.keyboard.press("Control+f");
      await type(page, page.getByLabel("Find in source", { exact: true }), "context");
      await caption("Find a phrase in your source.");
      await page.waitForTimeout(1800);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1600);
      await page.getByLabel("Find in source", { exact: true }).press("Escape");
      await click(page, page.getByRole("button", { name: "Open find in PDF" }));
      await type(page, page.getByLabel("Find in PDF", { exact: true }), "context");
      await page.locator(".pdf-find-flash").first().waitFor();
      await caption("Search the PDF. Keep the exact match in view.");
      await page.waitForTimeout(2300);
      await page.getByLabel("Find in PDF", { exact: true }).press("Enter");
      await page.waitForTimeout(1800);
      await shot("editor-search");
      await page.getByLabel("Find in PDF", { exact: true }).press("Escape");
      await page.locator(".cm-content").focus();
      await page.keyboard.press("Control+f");
      await type(page, page.getByLabel("Find in source", { exact: true }), "Questions to resolve");
      await click(page, page.getByRole("button", { name: "Show replacement", exact: true }));
      await type(page, page.getByLabel("Replace in source", { exact: true }), "Open research questions");
      await click(page, page.getByRole("button", { name: "Replace source match", exact: true }));
      await page.getByLabel("Find in source", { exact: true }).press("Escape");
      await caption("Refine the source, then review what changed.");
      await page.keyboard.press("Control+s");
      await page.waitForTimeout(2000);
      await click(page, tab(page, "right", "Proof"));
      await page.getByText("Open research questions", { exact: false }).first().waitFor();
      if (readFileSync(join(projectPath, "main.tex"), "utf8") !== manuscript.replace("Questions to resolve", "Open research questions")) throw new Error("Replacement changed unexpected manuscript text");
      if (!(await api("/compile", {})).ok) throw new Error("The edited manuscript did not compile");
      await page.waitForTimeout(3000);
    }
    const end = (Date.now() - started) / 1000;
    const path = await page.video()!.path();
    await context.close();
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    writeFileSync(join(out, `${clip}.json`), JSON.stringify({ clip, raw: path, start: marks[0].at, end, marks, size: [1600, 1000] }, null, 2));
    console.log(`RECORDED ${clip}: ${(end - marks[0].at).toFixed(1)} seconds`);
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  writeFileSync(join(out, "server.log"), logs);
}
