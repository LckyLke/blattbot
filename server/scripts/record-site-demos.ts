/** Record real UI walkthroughs against site-demo-project's isolated, prepared data.
 * DEMO_CLIP=workflow|evidence|graph|writing records one clip; default records all four.
 * DEMO_OUT_DIR changes the output folder. Run site-demo-project.ts --prepare first.
 * Captions and the pointer are presentation overlays; app state comes from real APIs.
 */
import { chromium, type Page, type Locator } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoRoot, project, projectPath, manuscript } from "./site-demo-project.js";
import { commitAll } from "../src/git.js";

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
  const clips = process.env.DEMO_CLIP ? [process.env.DEMO_CLIP] : ["workflow", "evidence", "graph", "writing"];
  for (const clip of clips) {
    if (!["workflow", "evidence", "graph", "writing"].includes(clip)) throw new Error("Unknown clip");
    writeFileSync(join(projectPath, "main.tex"), manuscript);
    if (clip === "workflow") {
      await commitAll(projectPath, "Prepare a clean starting draft for the workflow demo");
      await api("/chats", {});
    }
    await api("/compile", {});
    await api("/research/policy", { strict: false }, "PUT");
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: out, size: { width: 1600, height: 1000 } } });
    await context.addInitScript(({ clip }) => {
      localStorage.setItem("blattbot.paneLeft.v2", clip === "workflow" ? "chat" : clip === "writing" ? "source" : "pdf");
      localStorage.setItem("blattbot.paneRight.v2", ["workflow", "writing"].includes(clip) ? "pdf" : "research");
      localStorage.setItem("blattbot.panelWidth", clip === "writing" ? "540" : "690");
      localStorage.setItem("blattbot.sourceWrap", "1");
    }, { clip });
    const page = await context.newPage();
    const started = Date.now();
    const marks: { at: number; text: string }[] = [];
    const toolEvents: { at: number; name: string }[] = [];
    let segments: { start: number; end: number }[] | undefined;
    page.on("websocket", socket => socket.on("framereceived", frame => {
      try {
        const event = JSON.parse(String(frame.payload));
        if (event.type === "tool_start") {
          toolEvents.push({ at: (Date.now() - started) / 1000, name: event.name });
          console.log(`Actual agent tool: ${event.name}`);
        }
      } catch {}
    }));
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
      await page.evaluate(({ clip, text }) => { const el = document.getElementById("demo-caption")!; el.replaceChildren(); const tag = document.createElement("span"); tag.textContent = clip === "workflow" ? "EDIT · COMPILE · REVIEW" : clip === "evidence" ? "READ & VERIFY" : clip === "graph" ? "CONNECT YOUR SOURCES" : "FIND & REFINE"; el.append(tag, text); }, { clip, text });
      console.log(`${clip}: ${text}`);
    };
    const shot = async (name: string) => {
      await page.screenshot({ path: join(out, `${name}.png`) });
    };
    const research = page.locator(".research-panel").filter({ visible: true });
    if (clip === "workflow") {
      const now = () => (Date.now() - started) / 1000;
      await caption("Your draft, its PDF, and an assistant ready to help.");
      await page.waitForTimeout(2200);
      await click(page, page.getByRole("button", { name: "Edit", exact: true }));
      await caption("Describe the change you want.");
      const composer = page.getByPlaceholder(/Ask BlattBot/);
      await point(page, composer);
      await composer.focus();
      await page.keyboard.type("Turn the related-work plan into a three-item numbered checklist. Keep the meaning and citations unchanged. Only edit that section, then compile.", { delay: 24 });
      await page.waitForTimeout(1000);
      await page.keyboard.press("Enter");
      await caption("The agent edits and compiles. Waiting time is shortened.");
      const sent = now();
      await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ timeout: 30000 });
      let showedDiff = false;
      for (let i = 0; i < 600; i++) {
        const state = await api("");
        if (state.hasChanges && !showedDiff) {
          await click(page, tab(page, "right", "Proof"));
          showedDiff = true;
        }
        if (!state.turnActive) break;
        if (i === 599) throw new Error("Agent turn did not finish");
        await page.waitForTimeout(1000);
      }
      await page.getByText(/turn complete/).first().waitFor({ timeout: 30000 });
      const complete = now();
      if (!toolEvents.some(e => /compile/i.test(e.name))) throw new Error("The agent did not compile its edit");
      const changed = readFileSync(join(projectPath, "main.tex"), "utf8");
      const section = String.raw`\section{A plan for related work}`;
      const after = String.raw`\section{Questions to resolve}`;
      if (!changed.includes(String.raw`\begin{enumerate}`) || changed.split(section)[0] !== manuscript.split(section)[0] || changed.split(after)[1] !== manuscript.split(after)[1]) throw new Error("The agent edit exceeded the requested section");
      if (!(await api("")).lastCompile?.ok) throw new Error("The agent's final PDF did not compile");
      await click(page, tab(page, "right", "Proof"));
      await caption("Read the exact changes before approving.");
      await page.waitForTimeout(4500);
      await shot("workflow-proof");
      await click(page, tab(page, "right", "PDF"));
      await page.locator(".textLayer").first().waitFor();
      await caption("Check the result in the compiled PDF.");
      await page.waitForTimeout(4000);
      await click(page, tab(page, "right", "Proof"));
      await caption("Approve the edit when you are happy with it.");
      await page.waitForTimeout(1600);
      await click(page, page.getByRole("button", { name: "Approve & push", exact: true }));
      await page.getByText(/No pending changes/).waitFor({ timeout: 30000 });
      if ((await api("")).hasChanges) throw new Error("Approval left uncommitted changes");
      await caption("Saved locally. Connected projects can also sync to Overleaf.");
      await page.waitForTimeout(1800);
      await click(page, tab(page, "right", "PDF"));
      await page.waitForTimeout(3300);
      // Keep real tool activity and the entire review/approval, removing long idle waits.
      const activity = toolEvents.filter(e => e.at >= sent && e.at < complete);
      const chosen = [activity[0], activity.find(e => /edit|write/i.test(e.name)), activity.find(e => /compile/i.test(e.name))].filter((e): e is { at: number; name: string } => !!e);
      const windows = [{ start: marks[0].at, end: sent + 1 }, ...chosen.map(e => ({ start: Math.max(sent, e.at - 0.4), end: Math.min(complete, e.at + 2.8) })), { start: complete, end: now() }].sort((a, b) => a.start - b.start);
      segments = [];
      for (const window of windows) {
        const previous = segments.at(-1);
        if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
        else segments.push(window);
      }
    } else if (clip === "evidence") {
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
    writeFileSync(join(out, `${clip}.json`), JSON.stringify({ clip, raw: path, start: marks[0].at, end, marks, segments, toolEvents, size: [1600, 1000] }, null, 2));
    console.log(`RECORDED ${clip}: ${(end - marks[0].at).toFixed(1)} seconds`);
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
  writeFileSync(join(out, "server.log"), logs);
}
