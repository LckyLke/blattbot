/**
 * Record the demo video: an isolated BlattBot + mock Overleaf, a real agent
 * turn on the demo thesis, captured with Playwright's video recorder.
 * Costs one agent turn (~$0.30). Output: a raw .webm plus segment timestamps
 * on stdout for post-processing into the landing-page clip.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOverleaf } from "./mock-overleaf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.DEMO_OUT_DIR ?? "/tmp/blattbot-demo";
const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const SERVER_PORT = 4630;
const MOCK_PORT = 4631;
const PROJECT_ID = "0123456789abcdef01234567";
const COOKIE = "overleaf_session2=mock-session";

const MAIN_TEX = `\\documentclass{article}
\\title{Attention-Based Models for Structured Prediction}
\\author{Demo Author}
\\begin{document}
\\maketitle
\\section{Introduction}
Attention mechanisms let a model weigh context dynamically~\\cite{vaswani2017attention}.
Transformer architectures built on this idea now dominate language modelling,
and pretrained models transfer it across tasks.
% TODO: cite the original transformer paper and BERT here
\\newpage
\\section{Methods}
We study $f(x) = \\sigma(Wx + b)$ under standard assumptions.
\\newpage
\\section{Conclusion}
The approach compiles reliably.
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;

const REFS_BIB = `@inproceedings{vaswani2017attention,
  title     = {Attention is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and others},
  booktitle = {Advances in Neural Information Processing Systems},
  year      = {2017},
}
`;

const PROMPT =
  "Resolve the TODO in the introduction: find the original transformer paper " +
  "and the BERT paper, add both to the bibliography, and cite them at the " +
  "marked spot. Keep the prose unchanged otherwise and make sure it compiles.";

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const mock = await startMockOverleaf(MOCK_PORT, PROJECT_ID, "Attention Models");
  mock.files.set("main.tex", Buffer.from(MAIN_TEX));
  mock.files.set("refs.bib", Buffer.from(REFS_BIB));

  const dataDir = mkdtempSync(join(tmpdir(), "blattbot-demo-"));
  const realTectonic = join(homedir(), ".local", "share", "blattbot", "bin", "tectonic");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  if (existsSync(realTectonic)) symlinkSync(realTectonic, join(dataDir, "bin", "tectonic"));

  const server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, BLATTBOT_PORT: String(SERVER_PORT), BLATTBOT_DATA_DIR: dataDir },
    stdio: "inherit",
  });

  const api = `http://127.0.0.1:${SERVER_PORT}/api`;
  let browser;
  const t0 = Date.now();
  const mark = (label: string) => console.log(`MARK ${label} ${((Date.now() - t0) / 1000).toFixed(1)}`);

  try {
    // Wait for the server + auth token.
    let token = "";
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${api}/bootstrap`);
        if (res.ok) {
          token = ((await res.json()) as { token: string }).token;
          break;
        }
      } catch {
        /* booting */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!token) throw new Error("server did not come up");
    const afetch = (url: string, init: RequestInit = {}) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      });

    // Pre-connect the account + project so the video opens on a ready dashboard.
    const acc = (await (
      await afetch(`${api}/accounts`, {
        method: "POST",
        body: JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}`, cookie: COOKIE }),
      })
    ).json()) as { id: string };
    await afetch(`${api}/projects`, {
      method: "POST",
      body: JSON.stringify({ accountId: acc.id, projectId: PROJECT_ID, name: "Attention Models" }),
    });

    browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
    // Crispness: Playwright records CSS pixels, so render the app at 2x via a
    // big viewport + CSS zoom (layout behaves like 1440×900, pixels are 2880).
    const context = await browser.newContext({
      viewport: { width: 2880, height: 1800 },
      recordVideo: { dir: OUT_DIR, size: { width: 2880, height: 1800 } },
    });
    const page = await context.newPage();

    // CSS zoom breaks coordinate-based actionability in nested layouts, so all
    // interactions below go through DOM clicks and raw keyboard events.
    const domClick = async (loc: ReturnType<typeof page.locator>) => {
      await loc.first().waitFor({ timeout: 60_000 });
      await loc.first().evaluate((el) => (el as HTMLElement).click());
    };

    // --- The recorded session -------------------------------------------------
    await page.goto(`http://127.0.0.1:${SERVER_PORT}`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = "2";
    });
    mark("dashboard");
    await page.waitForTimeout(1800);

    await domClick(page.getByRole("button", { name: "Open Attention Models" }));
    // Chat left, PDF right by default; the PDF compiles on open.
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 120_000 });
    mark("project-open");
    await page.waitForTimeout(1500);

    // Research mode: the literature pipeline is the star of this demo.
    await domClick(page.getByRole("button", { name: "Research", exact: true }));
    await page.waitForTimeout(400);

    const composer = page.getByPlaceholder(/Ask BlattBot/);
    await composer.first().evaluate((el) => (el as HTMLTextAreaElement).focus());
    await page.keyboard.type(PROMPT, { delay: 24 });
    await page.waitForTimeout(600);
    mark("send");
    await page.keyboard.press("Enter");

    // The agent works: literature search chips, citations added, live diff.
    await page.getByText(/turn complete/).first().waitFor({ timeout: 420_000 });
    mark("turn-end");
    // Let the post-turn compile land so the PDF shows the new citations.
    await page.waitForTimeout(9_000);
    mark("pdf-settled");

    // The new entries in the References tab, cited and green.
    await domClick(
      page.locator('aside[data-pane="right"]').getByRole("button", { name: "References", exact: true }),
    );
    await page.waitForTimeout(3200);
    mark("refs");

    // Review the proof, then approve.
    await domClick(
      page.locator('aside[data-pane="right"]').getByRole("button", { name: "Proof", exact: false }),
    );
    await page.waitForTimeout(2600);
    mark("proof");
    await domClick(page.getByRole("button", { name: "Approve & push" }));
    await page.getByText("Changes pushed to Overleaf.").waitFor({ timeout: 60_000 });
    mark("approved");
    await page.waitForTimeout(2500);

    await context.close(); // finalizes the video file
    const video = readdirSync(OUT_DIR).find((f) => f.endsWith(".webm"));
    console.log(`VIDEO ${join(OUT_DIR, video ?? "")}`);
    console.log("pushed to mock:", JSON.stringify(mock.uploads.map((u) => u.path)));
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ DEMO RECORDING FAILED:", err);
  process.exit(1);
});
