/**
 * Environment diagnostic: platform, data dir, git, TeX engine, Claude Code
 * CLI, and every browser cookie store BlattBot can see. Shared by
 * `blattbot doctor` (compiled into dist/) and server/scripts/doctor.ts.
 */
import { platform, arch, homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectEngines } from "./compile.js";
import { discoverProfiles } from "./overleaf/browsers.js";
import { isWsl, windowsUserHomes } from "./overleaf/wsl.js";
import { DATA_DIR } from "./config.js";
import { loadSettings } from "./settings.js";
import { agentSdkVersion, describeEngine } from "./sdkinfo.js";
import { codexStatus } from "./codexinfo.js";
import { selectedBackend } from "./settings.js";

const execFileP = promisify(execFile);

/** First line of `cmd --version`, or null when the command is unavailable. */
export async function commandVersion(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, ["--version"], {
      timeout: 10_000,
      // .cmd shims (e.g. the claude CLI installed via npm) need a shell on Windows.
      shell: process.platform === "win32",
    });
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

export async function runDoctor(log: (line: string) => void = console.log): Promise<void> {
  const home = homedir();
  const short = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);

  log(`Platform:  ${platform()} ${arch()}  ·  Node ${process.version}`);
  log(`Data dir:  ${short(DATA_DIR)}`);
  log(`Backend:   ${selectedBackend(loadSettings())}`);
  const codex = await codexStatus();
  log(`Codex:     ${codex.message}`);
  log(`           ${codex.executable}${codex.defaultModel ? ` · default model: ${codex.defaultModel}` : ""}`);

  const git = await commandVersion("git");
  log(`git:       ${git ?? "NOT FOUND — required; install it from https://git-scm.com"}`);

  // Same chain a compile walks, configured preference included.
  const [engine, ...fallbacks] = await detectEngines(loadSettings().engine || undefined);
  log(
    `TeX:       ${
      engine
        ? `${engine.name} (${short(engine.path)})${fallbacks.length ? `  ·  falls back to ${fallbacks.map((e) => e.name).join(", ")}` : "  ·  no fallback engine installed"}`
        : "none found — run `blattbot` to download tectonic, or install latexmk/pdflatex yourself"
    }`,
  );

  const claude = await commandVersion("claude");
  log(
    `Claude:    ${claude ? `${claude} — installed (login not checked)` : "optional — install Claude Code or set an Anthropic API key to use the Claude backend"}`,
  );
  log(`Engine:    Agent SDK ${agentSdkVersion() ?? "not installed"} · ${describeEngine()}`);

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
}
