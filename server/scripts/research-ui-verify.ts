/** Isolated browser checks for Research. Uses a local fixture model; no paid calls. */
import { verifyGraphExplorer } from "./graph-explorer-verify.js";
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
  textPdf(["Graph Models. Introduction.", quote]),
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
  // Opening an existing project must populate the default graph without a build click.
  await research
    .getByRole("button", { name: "External source: Shared Foundations" })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".cg-index-status"),
  );
  if (graphLookups !== 3)
    throw new Error(
      `Expected two automatic lookups and one metadata batch, got ${graphLookups}`,
    );
  await page.screenshot({ path: join(shots, "00-graph-default.png") });
  await verifyGraphExplorer(page, base, project.id, shots);
  await research.getByRole("button", { name: "Library", exact: true }).click();
  await research.getByRole("button", { name: /Index missing & changed sources/ }).click();
  await research.getByText("2 full texts · 0 abstracts", { exact: true }).waitFor();
  await research.getByLabel("Search the paper library", { exact: true }).fill("dataset A");
  await research.getByRole("button", { name: "Search papers", exact: true }).click();
  await research.getByRole("heading", { name: "Graph Models", exact: true }).waitFor();
  await research.getByRole("heading", { name: "Neural Optimization", exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "06-library.png") });
  await research.getByRole("button", { name: "Memory", exact: true }).click();
  await research
    .getByLabel("Research question", { exact: true })
    .fill("How do graph models generalize across datasets?");
  await research
    .getByRole("button", { name: "Save accepted project memory" })
    .click();
  await research.getByText("Revision 1", { exact: true }).waitFor();
  await research.getByRole("button", { name: "Evidence", exact: true }).click();
  await research.getByLabel("Strict mode — resolve evidence gaps before approval").check();
  await page.waitForFunction(async ({ base, id, token }) => { const r = await fetch(`${base}/api/projects/${id}/research/strict`, { headers: { Authorization: `Bearer ${token}` } }); return (await r.json()).strict; }, { base, id: project.id, token });
  const strictAttempt = await fetch(`${base}/api/projects/${project.id}/approve`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
  if (strictAttempt.status !== 422 || !(await strictAttempt.text()).includes("Strict writing mode")) throw new Error("Strict approval gate did not block unresolved evidence");
  await research.getByRole("button", { name: "Check assertions without citations" }).click();
  await page.waitForFunction(async ({ base, id, token }) => { const r = await fetch(`${base}/api/projects/${id}/research/strict`, { headers: { Authorization: `Bearer ${token}` } }); return (await r.json()).auditCurrent; }, { base, id: project.id, token });
  await page.screenshot({ path: join(shots, "09-strict.png") });
  await research.getByLabel("Strict mode — resolve evidence gaps before approval").uncheck();
  await research
    .getByRole("button", { name: "Check evidence", exact: true })
    .click();
  await research.getByText("Supports claim", { exact: true }).waitFor();
  await research.getByText("Evidence & explanation", { exact: true }).click();
  await research.getByRole("button", { name: "Open source · page 2" }).click();
  await research
    .getByRole("region", { name: "Original source passage" })
    .waitFor();
  await research
    .getByRole("button", { name: "Show original page image" })
    .click();
  await research.locator(".research-source img").waitFor();
  await page.screenshot({ path: join(shots, "01-evidence.png") });
  await research.getByRole("button", { name: "Close source" }).click();
  await research
    .getByRole("button", { name: "Related Work", exact: true })
    .click();
  await research
    .locator(".research-checklist")
    .getByLabel("alpha · Graph Models", { exact: true })
    .check();
  modelDelay = 1800;
  await research
    .getByRole("button", { name: "Analyze selected papers" })
    .click();
  const tasks = research.locator(".research-task-list");
  await tasks.locator(":scope > summary").click();
  await tasks.getByRole("button", { name: "Pause", exact: true }).click();
  await tasks.getByText("Paused. Saved items are retained.", { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "10-tasks.png") });
  modelDelay = 0;
  await page.waitForTimeout(200);
  await tasks.getByRole("button", { name: "Resume / retry", exact: true }).click();
  await tasks.locator(":scope > summary").click();
  await research.getByRole("heading", { name: "alpha", exact: true }).waitFor();
  await research
    .getByLabel("Review notes", { exact: true })
    .fill("Use only the comparable dataset A result.");
  await research
    .getByLabel("I reviewed these fields against the source, including gaps.")
    .check();
  await research.getByRole("button", { name: "Save row review" }).click();
  await research.getByRole("button", { name: "Generate outline" }).click();
  await research
    .getByRole("button", { name: "Approve this outline" })
    .waitFor();
  if (
    await research
      .getByRole("button", { name: "Write Related Work in chat" })
      .isEnabled()
  )
    throw new Error("Writing enabled before outline approval");
  await research.getByRole("button", { name: "Approve this outline" }).click();
  await research.getByText("Approved by you", { exact: true }).waitFor();
  if (
    !(await research
      .getByRole("button", { name: "Write Related Work in chat" })
      .isEnabled())
  )
    throw new Error("Approved writing action is unavailable");
  await research
    .getByRole("button", { name: "Write Related Work in chat" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "02-related-work.png") });
  await research.getByRole("button", { name: "Checks", exact: true }).click();
  await research
    .getByRole("button", { name: "Review manuscript", exact: true })
    .click();
  await research
    .getByText("The conclusion claims universal validity from one dataset.", {
      exact: true,
    })
    .waitFor();
  await research
    .getByLabel("Your decision", { exact: true })
    .fill("Revise the conclusion to match the dataset.");
  await research.getByRole("button", { name: "Save note" }).click();
  await page.screenshot({ path: join(shots, "03-checks.png") });
  await research.getByText("Scientific quality benchmark", { exact: true }).click();
  await research.getByRole("button", { name: "Run benchmark with selected model" }).click();
  await research.getByText("15 evaluated · 0 human-reviewed reference cases", { exact: true }).waitFor();
  await research.getByText(/Agreement: Awaiting reviewed labels/).waitFor();
  const quality = await call(`/api/projects/${project.id}/research/evaluation`);
  if (quality.reviewed !== 0 || quality.groups.some((g: any) => g.accuracy !== null)) throw new Error("Unreviewed benchmark labels were scored");
  await page.screenshot({ path: join(shots, "11-quality.png") });
  await research.getByRole("button", { name: "Graph", exact: true }).click();
  await research
    .getByRole("button", { name: "External source: Shared Foundations" })
    .waitFor();
  await research
    .getByRole("button", { name: "External source: Shared Foundations" })
    .click();
  await research.getByRole("button", { name: "Close paper details" }).click();
  await research
    .getByRole("button", {
      name: "Find missing sources",
    })
    .click();
  await research
    .getByText("Cited by 2 project papers: alpha; beta", { exact: true })
    .waitFor();
  await research.getByText("Compare two papers", { exact: true }).click();
  await research
    .getByRole("button", { name: "Find shared references" })
    .click();
  await research
    .getByRole("button", { name: "W3 · Shared Foundations", exact: true })
    .waitFor();
  await research.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: join(shots, "04-graph.png") });
  await page.setViewportSize({ width: 740, height: 1000 });
  await page.getByRole("tab", { name: "Research", exact: true }).first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, "05-narrow.png") });
  const bounds = await research.boundingBox();
  if (!bounds || bounds.x + bounds.width > 742)
    throw new Error("Research pane is clipped by the viewport");
  if (await research.evaluate((el) => el.scrollWidth > el.clientWidth + 2))
    throw new Error("Research panel overflows horizontally");
  // Ctrl-F is scoped to the active pane even when Source and PDF are side by side.
  await page.setViewportSize({ width: 1500, height: 980 });
  const compiled = await call(`/api/projects/${project.id}/compile`, {});
  if (!compiled.hasPdf) throw new Error("Search fixture did not compile into a PDF");
  writeFileSync(join(root, "builds", project.id, "main.pdf"), textPdf([
    "This introductory line is deliberately long enough to occupy the first text item. The actual exam- ple comes here. Another example follows.",
    "A final example on another page."
  ]));
  await page.getByRole("tab", { name: "Source", exact: true }).first().click();
  await page.getByRole("tab", { name: "PDF", exact: true }).last().click();
  await page.locator(".textLayer").first().waitFor();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+f");
  const sourceFind = page.getByLabel("Find in source", { exact: true });
  await sourceFind.fill("\\documentclass");
  await page.locator(".blattbot-source-search").getByText("1/1", { exact: true }).waitFor();
  if (await page.getByLabel("Find in PDF", { exact: true }).isVisible()) throw new Error("PDF search intercepted Source Ctrl-F");
  await page.getByRole("button", { name: "Regular expression", exact: true }).click();
  await sourceFind.fill("([");
  await page.getByText("Invalid pattern", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Regular expression", exact: true }).click();
  await sourceFind.fill("");
  await sourceFind.pressSequentially("results", { delay: 50 });
  if (await sourceFind.inputValue() !== "results") throw new Error("Live source search replaced previously typed characters");
  await page.locator(".blattbot-source-search").getByText("1/1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show replacement", exact: true }).click();
  await page.getByLabel("Replace in source", { exact: true }).fill("findings");
  await page.getByRole("button", { name: "Replace source match", exact: true }).click();
  await page.locator(".cm-content").getByText("These findings hold for every dataset.", { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, "08-source-search.png") });
  await sourceFind.press("Escape");
  await page.keyboard.press("Control+z");
  await page.locator(".cm-content").getByText("These results hold for every dataset.", { exact: true }).waitFor();
  await page.locator(".textLayer").first().click();
  await page.keyboard.press("Control+f");
  const pdfFind = page.getByLabel("Find in PDF", { exact: true });
  await pdfFind.fill("example");
  const pdfSearch = page.getByRole("search", { name: "PDF search" });
  await pdfSearch.getByText("1/3", { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".pdf-find-flash")].some(el => el.getAttribute("data-quote") === "exam- ple"));
  await page.waitForTimeout(2200);
  if (!(await page.locator(".pdf-find-flash").count())) throw new Error("Active PDF match disappeared while find was open");
  await pdfFind.press("Enter");
  await pdfSearch.getByText("2/3", { exact: true }).waitFor();
  await pdfFind.press("Shift+Enter");
  await pdfSearch.getByText("1/3", { exact: true }).waitFor();
  if (await pdfSearch.evaluate(el => el.scrollWidth > el.clientWidth + 2)) throw new Error("PDF search overflows its pane");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".pdf-find-flash")].some(el => el.getAttribute("data-quote") === "exam- ple"));
  await page.screenshot({ path: join(shots, "07-search.png") });
  await pdfFind.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".pdf-find-flash").length === 0);
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log(`Research browser workflow passed. Screenshots: ${shots}`);
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
