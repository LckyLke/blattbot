/** Isolated browser checks for Research. Uses a local fixture model; no paid calls. */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { textPdf } from "../test/fixtures/pdf.js";
const root = mkdtempSync(join(tmpdir(), "blattbot-research-ui-"));
const shots = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-research-ui";
mkdirSync(shots, { recursive: true });
const port = 4578,
  modelPort = 4579,
  base = `http://127.0.0.1:${port}`;
const quote = "Accuracy was 91 percent on dataset A.";
let graphLookups = 0;
let modelDelay = 0;
const works = {
  W1: {
    id: "https://openalex.org/W1",
    display_name: "Graph Models",
    doi: "https://doi.org/10.1234/alpha",
    publication_year: 2020,
    referenced_works: ["https://openalex.org/W2", "https://openalex.org/W3"],
  },
  W2: {
    id: "https://openalex.org/W2",
    display_name: "Neural Optimization",
    doi: "https://doi.org/10.1234/beta",
    publication_year: 2021,
    referenced_works: ["https://openalex.org/W3"],
  },
  W3: {
    id: "https://openalex.org/W3",
    display_name: "Shared Foundations",
    doi: "https://doi.org/10.1234/shared",
    publication_year: 2018,
    referenced_works: [],
  },
};
const model = createServer(async (req, res) => {
  if (req.url?.startsWith("/openalex/")) {
    graphLookups++;
    const url = new URL(
      req.url.replace("/openalex", ""),
      "https://api.openalex.org",
    );
    let result: unknown;
    if (url.searchParams.has("filter"))
      result = { results: Object.values(works) };
    else {
      const path = decodeURIComponent(url.pathname);
      result = path.includes("alpha")
        ? works.W1
        : path.includes("beta")
          ? works.W2
          : works.W3;
    }
    // Leave enough time for the browser to see partial results and progress.
    await new Promise((resolve) => setTimeout(resolve, 650));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = payload.messages[0].content as string;
  let content = "Fixture response";
  if (modelDelay) await new Promise(resolve => setTimeout(resolve, modelDelay));
  if (prompt.includes("Identify assertions without citations")) {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    content = JSON.stringify(batch.map((p: any) => ({ id: p.id, classification: "needs_evidence", reason: "This generalization requires evidence." })));
  } else if (prompt.includes("Build a literature comparison row"))
    content = JSON.stringify(
      Object.fromEntries(
        [
          "question",
          "method",
          "data",
          "results",
          "limitations",
          "relevance",
        ].map((f) => [
          f,
          {
            text: `${f}: the comparison is restricted to dataset A.`,
            quotes: [{ page: 2, quote }],
          },
        ]),
      ),
    );
  else if (prompt.includes("Check whether this cited work"))
    content = JSON.stringify({
      verdict: "supported",
      explanation: "The source states the matching result and dataset.",
      quotes: [{ page: 2, quote }],
    });
  else if (prompt.includes("Propose a Related Work outline"))
    content =
      "## Graph-based methods\nCompare alpha and beta using their dataset A evidence.\n\n## Limits\nDo not compare different datasets without qualification.";
  else if (prompt.includes("Review scientific consistency"))
    content = JSON.stringify({
      coverage: "Compared results and conclusion in main.tex.",
      issues: [
        {
          category: "claims",
          severity: "moderate",
          explanation:
            "The conclusion claims universal validity from one dataset.",
          suggestion: "Limit the conclusion to dataset A.",
          locations: [
            {
              file: "main.tex",
              quote: "These results hold for every dataset.",
            },
          ],
        },
      ],
    });
  if (prompt.includes("Assess the user's reading note")) content = JSON.stringify({ verdict: "consistent", explanation: "The quoted result uses the same metric and dataset.", quotes: [{ page: 2, quote }], suggestedRevision: "Accuracy was 91 percent on dataset A; broader generalization is not established." });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise<void>((resolve) =>
  model.listen(modelPort, "127.0.0.1", resolve),
);
// This project predates the server: startup must build it without opening Research.
process.env.BLATTBOT_DATA_DIR = root;
const cfg = await import("../src/config.js");
const project = cfg.addProject({
  name: "Research Fixture",
  kind: "local",
  gitUrl: "",
});
const dir = cfg.projectDir(project.id);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "main.tex"),
  "\\documentclass{article}\n\\begin{document}\nAccuracy was 91 percent~\\cite{alpha}.\n\nThese results hold for every dataset.\n\\end{document}\n",
);
writeFileSync(
  join(dir, "refs.bib"),
  "@article{alpha,title={Graph Models},author={Ada Smith},year={2020},doi={10.1234/alpha}}\n@article{beta,title={Neural Optimization},author={Bea Jones},year={2021},doi={10.1234/beta}}",
);
writeFileSync(
  join(dir, "alpha.pdf"),
  textPdf(["Graph Models. Introduction.", quote, "References\n[1] Someone. Bibliographyonly methods. 2020."]),
);

writeFileSync(join(dir, "beta.pdf"), textPdf(["Neural Optimization. Introduction.", quote]));

// Test transport only: exercise the real startup worker without public API calls.
const preload = join(root, "fixture-fetch.mjs");
writeFileSync(
  preload,
  `
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input);
    return originalFetch(url.hostname === "api.openalex.org" ? "http://127.0.0.1:${modelPort}/openalex" + url.pathname + url.search : input, init);
  };
`,
);
const server = spawn(
  process.execPath,
  ["--import", preload, "--import", "tsx", "src/index.ts"],
  {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      BLATTBOT_PORT: String(port),
      BLATTBOT_DATA_DIR: root,
    },
    stdio: "pipe",
  },
);
let logs = "";
server.stdout?.on("data", (c) => {
  logs += c;
});
server.stderr?.on("data", (c) => {
  logs += c;
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let token = "";
async function call(path: string, body?: unknown, method = "POST") {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      token = ((await (await fetch(base + "/api/bootstrap")).json()) as any)
        .token;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!token) throw new Error(`Server did not start: ${logs}`);
  await call(
    "/api/settings",
    {
      backend: "openai",
      openaiBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
      openaiModel: "fixture",
    },
    "PUT",
  );
  browser = await chromium.launch({
    executablePath:
      process.env.BLATTBOT_BROWSER_EXECUTABLE ||
      ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 980 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() => {
    localStorage.setItem("blattbot.paneLeft.v2", "chat");
    localStorage.setItem("blattbot.paneRight.v2", "research");
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open Research Fixture" }).click();
  const research = page.locator(".research-panel:not(.cg-portal-root)").filter({ visible: true });
  await research
    .getByRole("heading", { name: "Research", exact: true })
    .waitFor();
  const nav = research.getByRole("navigation", { name: "Research views" });
  if (JSON.stringify(await nav.getByRole("button").allTextContents()) !== JSON.stringify(["Graph", "Library", "Reading"])) throw new Error("Unexpected Research tabs");
  await research.getByRole("button", { name: "External source: Shared Foundations" }).waitFor();
  const graphSearch = research.getByRole("searchbox", { name: "Find a paper" });
  await graphSearch.fill("alpha"); await graphSearch.press("Enter");
  await research.getByRole("button", { name: "Search this source" }).click();
  const query = research.getByRole("searchbox", { name: "Search inside your sources" });
  await query.fill("bibliographyonly");
  // Wait for automatic indexing to complete before checking search coverage.
  for (let i = 0; i < 80; i++) {
    const status = await call(`/api/projects/${project.id}/research/library`);
    if (status.indexed === 2) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await research.getByRole("button", { name: "Search", exact: true }).click();
  await research.getByText("No matching content passages", { exact: true }).waitFor();
  await research.getByText("Search options", { exact: true }).click();
  await research.getByLabel("Include bibliography sections").check();
  await research.getByRole("button", { name: "Search", exact: true }).click();
  await research.locator(".library-page-label").filter({ hasText: "Bibliography" }).waitFor();
  await research.getByLabel("Include bibliography sections").uncheck();
  await query.fill("91 percent");
  await research.getByRole("button", { name: "Search", exact: true }).click();
  await research.locator(".library-passage mark").first().waitFor();
  await page.screenshot({ path: join(shots, "01-library.png"), fullPage: true });
  await research.getByRole("button", { name: "Read in context" }).click();
  const reader = page.getByRole("dialog", { name: "Read source", exact: true });
  await reader.getByText("Page 2 of 3", { exact: true }).waitFor();
  await reader.getByRole("button", { name: "Read & take notes" }).click();
  await research.getByLabel("Reading page").waitFor();
  await research.locator(".reading-page pre").getByText(quote, { exact: true }).waitFor();
  await research.locator(".reading-page pre").evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  await research.getByRole("button", { name: "Note on selected passage" }).click();
  const note = research.getByRole("textbox", { name: "Note text" });
  await note.fill("The paper reports 91 percent accuracy on dataset A.");
  // Immediate navigation must flush the draft, without waiting for debounce.
  await nav.getByRole("button", { name: "Library", exact: true }).click();
  await nav.getByRole("button", { name: "Reading", exact: true }).click();
  if (await note.inputValue() !== "The paper reports 91 percent accuracy on dataset A.") throw new Error("Draft lost on tab switch");
  await research.getByRole("button", { name: "Check against paper" }).click();
  await research.getByText("Consistent with excerpts", { exact: true }).waitFor();
  await research.getByRole("button", { name: "Read page 2" }).click();
  await research.getByRole("button", { name: "Read in full screen" }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.screenshot({ path: join(shots, "02-reading-notes.png"), fullPage: true });
  await research.getByRole("button", { name: "Exit reading full screen" }).click();
  await note.fill("The paper proves perfect accuracy for every dataset.");
  await research.getByText("Changed · check again", { exact: true }).waitFor();
  await research.getByRole("button", { name: "Save", exact: true }).click();
  await research.locator(".reading-note header").getByText("Saved", { exact: true }).waitFor();
  const notes = await call(`/api/projects/${project.id}/research/notes?key=alpha`);
  if (!notes[0].assessmentStale || !notes[0].quote.includes(quote)) throw new Error("Note check/selection persistence failed");
  const download = page.waitForEvent("download");
  await research.getByRole("button", { name: "Export ↓", exact: true }).click();
  if (!(await download).suggestedFilename().endsWith("-notes.md")) throw new Error("Export failed");
  await research.getByRole("button", { name: "Remove note", exact: true }).click();
  await research.getByRole("button", { name: "Undo", exact: true }).click();
  await note.waitFor();
  await research.getByRole("button", { name: "Original page", exact: true }).click();
  await page.waitForFunction(() => { const image = document.querySelector(".reading-page img") as HTMLImageElement; return image?.complete && image.naturalWidth > 0; });
  await research.getByRole("button", { name: "Text view", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("tab", { name: "Research", exact: true }).filter({ visible: true }).first().click();
  await research.getByRole("navigation", { name: "Research views" }).getByRole("button", { name: "Reading", exact: true }).click();
  await page.screenshot({ path: join(shots, "03-reading-narrow.png"), fullPage: true });
  if (await research.evaluate(element => element.scrollWidth > element.clientWidth + 2)) throw new Error("Research overflows the pane");
  const savedForRecovery = (await call(`/api/projects/${project.id}/research/notes?key=alpha`))[0];
  await page.evaluate(({ projectId, note }) => localStorage.setItem(`blattbot.reading-draft.${projectId}.${note.id}`, JSON.stringify({ revision: note.revision, text: "Recovered local thought about perfect accuracy.", kind: "note" })), { projectId: project.id, note: savedForRecovery });
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.reload();
  const reopen = page.getByRole("button", { name: "Open Research Fixture" });
  await research.or(reopen).first().waitFor();
  if (await reopen.isVisible()) await reopen.click();
  await research.getByRole("navigation", { name: "Research views" }).getByRole("button", { name: "Reading", exact: true }).click();
  await note.waitFor();
  if (!(await note.inputValue()).includes("Recovered local thought")) throw new Error("Local draft recovery failed");
  if (await research.getByLabel("Reading page").inputValue() !== "2") throw new Error("Reading position did not survive reload");
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log(`Research browser workflow passed: three views, graph navigation, bibliography filtering, quoted search results, source reader, anchored notes, autosave across tabs, agent checks, stale checks, export, undo, original page image, narrow layout, draft recovery, reading position persistence. Screenshots: ${shots}`);

} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", () => resolve());
  });
  await new Promise<void>((resolve) => model.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
