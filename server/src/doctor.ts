/**
 * Environment diagnostic: platform, Node, data dir, required tools (git),
 * optional ones (tar, TeX, Codex, Claude Code, the optional Claude Agent SDK,
 * Poppler, Tesseract), and every browser cookie store BlattBot can see.
 * Shared by `blattbot doctor` (compiled into dist/) and server/scripts/doctor.ts.
 *
 * runDoctor returns what is missing: `failures` are required tools (the CLI
 * exits non-zero), `warnings` are optional ones that limit some features.
 */
import { platform, arch, homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectEngines } from "./compile.js";
import { discoverProfiles } from "./overleaf/browsers.js";
import { isWsl, windowsUserHomes } from "./overleaf/wsl.js";
import { DATA_DIR } from "./config.js";
import { loadSettings } from "./settings.js";
import { describeEngine } from "./sdkinfo.js";
import { claudeSdkStatus } from "./claude-sdk.js";
import { codexStatus } from "./codexinfo.js";
import { selectedBackend } from "./settings.js";
import { MIN_NODE, nodeSupported } from "./node-version.js";
import { ocr, ocrLanguageInstalled, renderer } from "./research/pdfreading.js";

const execFileP = promisify(execFile);

/** First output line of `cmd <args>` (stdout, else stderr), or null when the command is unavailable. */
export async function commandVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: 10_000,
      // .cmd shims (e.g. the claude CLI installed via npm) need a shell on Windows.
      shell: process.platform === "win32",
    });
    const first = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first(stdout) ?? first(stderr) ?? "";
  } catch {
    return null;
  }
}

export interface DoctorResult {
  /** Required and missing: BlattBot cannot work properly. */
  failures: string[];
  /** Optional and missing: BlattBot runs, some features are limited. */
  warnings: string[];
}

export async function runDoctor(log: (line: string) => void = console.log): Promise<DoctorResult> {
  const home = homedir();
  const short = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);
  const failures: string[] = [];
  const warnings: string[] = [];

  log(`Platform:  ${platform()} ${arch()}`);
  if (nodeSupported()) log(`Node:      ${process.version}`);
  else {
    failures.push("Node.js");
    log(`Node:      ${process.version} — TOO OLD; BlattBot needs Node ${MIN_NODE} or newer (https://nodejs.org)`);
  }
  log(`Data dir:  ${short(DATA_DIR)}`);

  const git = await commandVersion("git");
  if (!git) failures.push("git");
  log(`git:       ${git ?? "NOT FOUND — required; install it from https://git-scm.com"}`);

  const tar = await commandVersion("tar");
  if (!tar) warnings.push("tar");
  log(`tar:       ${tar ?? "not found — optional; needed only to unpack the tectonic download"}`);

  // Same chain a compile walks, configured preference included.
  const [engine, ...fallbacks] = await detectEngines(loadSettings().engine || undefined);
  if (!engine) warnings.push("TeX engine");
  log(
    `TeX:       ${
      engine
        ? `${engine.name} (${short(engine.path)})${fallbacks.length ? `  ·  falls back to ${fallbacks.map((e) => e.name).join(", ")}` : "  ·  no fallback engine installed"}`
        : "none found — optional, but compiles fail without one; run `blattbot` to download tectonic, or install latexmk/pdflatex"
    }`,
  );

  log(`Backend:   ${selectedBackend(loadSettings())}`);
  // account/read over the local app-server: no model call.
  const codex = await codexStatus();
  if (!codex.available || !codex.authenticated) warnings.push("Codex");
  log(
    `Codex:     ${
      codex.available
        ? codex.authenticated
          ? `logged in${codex.authMethod ? ` (${codex.authMethod})` : ""}`
          : "installed, NOT logged in — run `codex login`"
        : `not available — ${codex.message}`
    }`,
  );
  log(`           ${codex.executable}${codex.defaultModel ? ` · default model: ${codex.defaultModel}` : ""}`);

  const claude = await commandVersion("claude");
  log(
    `Claude:    ${claude ? `${claude} — installed (login not checked)` : "optional — install Claude Code or set an Anthropic API key to use the Claude backend"}`,
  );
  const sdk = claudeSdkStatus();
  log(
    `Agent SDK: Claude Agent SDK ${
      sdk.installed
        ? `${sdk.version ?? "?"} — ${sdk.source === "managed" ? `installed by BlattBot (${short(sdk.location!)})` : "installed alongside BlattBot"}`
        : `not installed — optional, only the Claude backend needs it. Install it from Settings → Agent (${sdk.download})`
    }`,
  );
  log(`Engine:    ${describeEngine()}`);

  const poppler = await commandVersion(renderer(), ["-v"]);
  if (!poppler) warnings.push("Poppler");
  log(`Poppler:   ${poppler ?? "not found — optional; PDF page images fall back to the bundled PDF.js renderer"}`);
  const tesseract = await commandVersion(ocr());
  const english = tesseract ? await ocrLanguageInstalled() : false;
  if (!tesseract || !english) warnings.push("Tesseract");
  log(
    `Tesseract: ${
      tesseract
        ? english
          ? `${tesseract} (English data installed)`
          : `${tesseract} — English language data missing (tesseract-ocr-eng / tesseract-data-eng); OCR is unavailable`
        : "not found — optional; needed for OCR of scanned papers"
    }`,
  );

  if (isWsl()) {
    const homes = windowsUserHomes();
    log(
      `\nWSL detected — Windows user profiles reachable: ${homes.length > 0 ? homes.map(short).join(", ") : "none (is the Windows drive mounted under /mnt?)"}`,
    );
  }
  const profiles = discoverProfiles();
  log(`\nBrowser cookie stores discovered: ${profiles.length}`);
  for (const p of profiles) {
    log(`  · ${p.browser.padEnd(9)} [${p.family}]  ${short(p.cookieDb)}`);
  }
  if (profiles.length === 0) {
    log("  (none — you can still use 'Log in via browser' or paste a cookie manually)");
  }

  log("");
  log(
    failures.length > 0
      ? `Missing required: ${failures.join(", ")}. Install it, then run \`blattbot doctor\` again.`
      : "Required tools: all found.",
  );
  if (warnings.length > 0) log(`Optional, not ready: ${warnings.join(", ")} (BlattBot runs; related features are limited).`);
  return { failures, warnings };
}
