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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOverleaf } from "./mock-overleaf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-ui-shots";
const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const SERVER_PORT = 4570;
const MOCK_PORT = 4571;
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

    await page.getByPlaceholder(/overleaf\.com — or a project link/).fill(`http://127.0.0.1:${MOCK_PORT}`);
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
      text: "Persisted reply from an earlier session.",
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
    await aside().getByRole("button", { name: "Source", exact: true }).click();
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
    await aside().getByRole("button", { name: "Proof", exact: false }).click();
    await page
      .getByText("manual tweak from ui-verify")
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10_000 });
    await shot("25-proof-manual-edit");

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

    // Discard main.tex's remaining hunk via its × (server reverse-applies the
    // patch the client reconstructed from the diff) — the proof empties out.
    await page.getByRole("button", { name: "Discard this change in main.tex" }).click();
    await page.getByRole("button", { name: "Really discard this change in main.tex?" }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    const rejectHunkContentOk = (await getFile("main.tex")) === MAIN_TEX;
    await shot("25d-proof-hunk-discarded");

    // ---- References: cited entry renders leaf-green with a line-numbered jump ----
    await aside().getByRole("button", { name: "References", exact: true }).click();
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
      .getByRole("button", { name: "Source", exact: true })
      .evaluate((el) => el.className.includes("bg-ink-2"));
    const citeJumpOk =
      sourceTabActive &&
      (await aside().locator(".cm-content").first().innerText()).includes(
        "\\cite{vaswani2017attention}",
      );
    await shot("25f-refs-jump");

    // ---- Add a reference by hand → the .bib diff lands in the Proof ----
    await aside().getByRole("button", { name: "References", exact: true }).click();
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
    await aside().getByRole("button", { name: "References", exact: true }).click();
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
    await aside().getByRole("button", { name: "References", exact: true }).click();
    await aside().getByRole("button", { name: "Delete uiverify2024note" }).click();
    await aside().getByRole("button", { name: "Really delete uiverify2024note?" }).click();
    await aside()
      .getByRole("button", { name: "Delete uiverify2024note" })
      .waitFor({ state: "detached", timeout: 10_000 });
    await aside().getByRole("button", { name: "Proof", exact: false }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    // The .bib file is byte-identical to the pre-add state on disk.
    const refsBibRestored = (await getFile("sections/refs.bib")) === REFS_BIB;
    await shot("25j-refs-deleted");

    await aside().getByRole("button", { name: "Source", exact: true }).click();

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

    // ---- Opening the PDF tab auto-compiles, with a visible progress indicator ----
    await aside().getByRole("button", { name: "PDF", exact: true }).click();
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
    await leftPane().getByRole("button", { name: "Source", exact: true }).click();
    await leftPane().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });
    const sideBySideOk =
      (await leftPane().locator(".cm-content").filter({ visible: true }).count()) > 0 &&
      (await aside().locator("canvas").filter({ visible: true }).count()) > 0;
    await shot("37-side-by-side");

    // Selecting the right pane's view on the left SWAPS the two panes.
    await leftPane().getByRole("button", { name: "PDF", exact: true }).click();
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
    await aside().getByRole("button", { name: "Proof", exact: false }).click();
    await page.getByText("No pending changes").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
    await leftPane().locator(".textLayer span", { hasText: "Attention" }).first().dblclick();
    await aside().locator(".cm-flash-line").first().waitFor({ timeout: 10_000 });
    const dblclickSourceActive = await aside()
      .getByRole("button", { name: "Source", exact: true })
      .evaluate((el) => el.className.includes("bg-ink-2"));
    const dblclickJumpOk =
      dblclickSourceActive &&
      (await aside().locator(".cm-content").first().innerText()).includes("Attention mechanisms");
    await shot("40-pdf-dblclick-jump");

    // ---- Quote a PDF selection into the chat composer ----
    // Layout for this: chat on the left, PDF on the right (the chip only
    // offers itself while the other pane shows the chat).
    await leftPane().getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByTitle("Switch chat").waitFor({ timeout: 5_000 });
    await aside().getByRole("button", { name: "PDF", exact: true }).click();
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
    // Clear the injected draft and restore the layout the rest of the flow
    // expects (chat left, source right).
    await composer.fill("");
    await aside().getByRole("button", { name: "Source", exact: true }).click();
    await aside().locator(".cm-content").first().waitFor({ state: "visible", timeout: 15_000 });

    // Restore the chat on the left for the rest of the flow (right keeps source).
    await leftPane().getByRole("button", { name: "Chat", exact: true }).click();
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

    await page.getByRole("button", { name: "New blank project" }).click();
    await page.getByPlaceholder("My new paper").fill("Scratch Note");
    await page.getByRole("button", { name: "Create project" }).click();

    // It opens straight into the project view with the seeded template files.
    await page.getByRole("checkbox", { name: "Scope main.tex" }).waitFor({ timeout: 15_000 });
    await page.getByRole("checkbox", { name: "Scope references.bib" }).waitFor({ timeout: 5_000 });
    await aside().getByRole("button", { name: "Source", exact: true }).click();
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
        projClearOk,
        restoreUserOk,
        restoreTitleOk,
        restoreDiffOk,
        restoreTurnEndOk,
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
        rejectHunkContentOk,
        refChipLeaf,
        citeJumpOk,
        addProofOk,
        newChipGold,
        unusedBadgeOk,
        editProofOk,
        refsBibRestored,
        localFilesOk,
        publishOk,
        publishedRow,
        sideBySideOk,
        swapOk,
        textLayerSpans,
        textLayerSelectable,
        dblclickJumpOk,
        quoteInDraftOk,
        cardGridOk,
        wordmarkNavOk,
        customDialogOk,
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
    if (!projClearOk) {
      throw new Error("clearing the project override failed (or dropped the style/defaultMode)");
    }
    if (!restoreUserOk) throw new Error("persisted user message did not render after reload");
    if (!restoreTitleOk) throw new Error("chat title was not derived from the first user message");
    if (!restoreDiffOk) throw new Error("restored tool chip did not expand to the persisted fileDiff");
    if (!restoreTurnEndOk) throw new Error("persisted turn_end marker did not render after reload");
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
    if (!refChipLeaf) throw new Error("cited entry's key chip is not leaf-green");
    if (!citeJumpOk) throw new Error("usage jump did not reveal the cite line in the Source tab");
    if (!addProofOk) throw new Error("adding a reference showed no sections/refs.bib diff in the Proof");
    if (!newChipGold) throw new Error("uncited new entry's key chip is not gold/amber");
    if (!unusedBadgeOk) throw new Error("new entry does not show the unused badge");
    if (!editProofOk) throw new Error("editing the reference did not update the proof diff");
    if (!refsBibRestored) throw new Error("deleting the reference did not restore refs.bib to its pre-add state");
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
    console.log(`✅ UI verify finished — screenshots in ${SHOTS}`);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ UI VERIFY FAILED:", err);
  process.exit(1);
});
