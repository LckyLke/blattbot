#!/usr/bin/env node
/**
 * BlattBot CLI (`npx blattbot`) — first-run checks, then start the local
 * server and open the app in the browser. Plain Node ESM over the compiled
 * server in ../dist; no TypeScript, no dependencies beyond node builtins.
 *
 *   blattbot            start (default)
 *   blattbot doctor     environment diagnostics
 */
// Only long-standing builtins are imported statically, so that an old Node
// reaches the version check below instead of failing on an import.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const HELP = `BlattBot — agentic LaTeX editing for Overleaf, local-first.

Usage
  blattbot [options]     start the server and open the app
  blattbot doctor        print environment diagnostics (exits 1 if a required tool is missing)

Options
  --port <n>        port to listen on (default 4560; env BLATTBOT_PORT)
  --data-dir <p>    data directory (default ~/.local/share/blattbot; env BLATTBOT_DATA_DIR)
  --no-open         do not open the browser
  -y, --yes         answer yes to prompts (e.g. the tectonic download)
  -v, --version     print the version
  -h, --help        show this help

Environment
  BLATTBOT_PORT                 port to listen on (default 4560; --port wins)
  BLATTBOT_DATA_DIR             data directory (default ~/.local/share/blattbot; --data-dir wins)
  BLATTBOT_CODEX_EXECUTABLE     codex CLI to use instead of the one on PATH
  BLATTBOT_CLAUDE_EXECUTABLE    claude binary for the Claude backend instead of the bundled one
  BLATTBOT_BROWSER_EXECUTABLE   Chrome, Edge or Chromium for the university sign-in window
  BLATTBOT_PDFTOPPM             Poppler's pdftoppm, for PDF page images
  BLATTBOT_TESSERACT            tesseract, for OCR
  BLATTBOT_KWALLET              KDE wallet holding the browser cookie key (default kdewallet)
  BLATTBOT_REVISION             revision reported by /api/deployment (unattended deployments)
  BLATTBOT_START_DRAINED        1 = start with new writes paused for up to 2 minutes (updates)
  BLATTBOT_HOME                 home directory searched for browser profiles (default: yours)
  BLATTBOT_WSL                  1 or 0 forces WSL detection on or off
  BLATTBOT_WSL_MNT              where WSL mounts Windows drives (default /mnt)
  BLATTBOT_GIT_TOKEN            set by BlattBot for its own git processes; do not set it
  HTTPS_PROXY, NO_PROXY         proxy for the tectonic download (HTTP_PROXY too)
`;

// ---- argument parsing ------------------------------------------------------

function fail(message) {
  console.error(`blattbot: ${message}\n`);
  console.error(HELP);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { command: "start", open: true, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "doctor" && args.command === "start") args.command = "doctor";
    else if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail("--port needs a number between 1 and 65535");
      args.port = n;
    } else if (a === "--data-dir") {
      const p = argv[++i];
      if (!p) fail("--data-dir needs a path");
      args.dataDir = p;
    } else if (a === "--no-open") args.open = false;
    else if (a === "-y" || a === "--yes") args.yes = true;
    else if (a === "-v" || a === "--version") args.showVersion = true;
    else if (a === "-h" || a === "--help") args.showHelp = true;
    else fail(`unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.showHelp) {
  console.log(HELP);
  process.exit(0);
}
if (args.showVersion) {
  console.log(`blattbot v${pkg.version}`);
  process.exit(0);
}

// Environment must be set before any dist module is imported — the server
// reads BLATTBOT_PORT/BLATTBOT_DATA_DIR at module load.
if (args.port !== undefined) process.env.BLATTBOT_PORT = String(args.port);
if (args.dataDir !== undefined) process.env.BLATTBOT_DATA_DIR = resolve(args.dataDir);

if (!existsSync(join(__dirname, "..", "dist", "index.js"))) {
  console.error(
    "blattbot: compiled server not found (dist/index.js). In a source checkout run `npm run release:pack` first, or use `npm run dev`.",
  );
  process.exit(1);
}

// Before anything that needs a newer Node (node:sqlite) is loaded.
const { MIN_NODE, nodeSupported } = await import("../dist/node-version.js");
if (!nodeSupported()) {
  console.error(`blattbot: Node.js ${MIN_NODE} or newer is required, but this is Node ${process.version}.`);
  console.error("  Install the current LTS from https://nodejs.org (or `nvm install --lts`), then run blattbot again.");
  process.exit(1);
}

// node:sqlite (browser cookie stores) prints an ExperimentalWarning on
// Node 22 and 23. Drop exactly that one; every other warning still shows.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0]?.type ?? warning?.name);
  const message = typeof warning === "string" ? warning : warning?.message;
  if (type === "ExperimentalWarning" && /\bSQLite\b/.test(String(message))) return;
  return emitWarning.call(process, warning, ...rest);
};

const HOME = homedir();
const short = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

/** Absolute path of a command on PATH, or null. */
async function has(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileP(finder, [cmd]);
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

// ---- doctor ----------------------------------------------------------------

if (args.command === "doctor") {
  const { runDoctor } = await import("../dist/doctor.js");
  const { failures } = await runDoctor();
  process.exit(failures.length > 0 ? 1 : 0);
}

// ---- first-run checks ------------------------------------------------------

const { detectEngine, resetEngineCache } = await import("../dist/compile.js");
const { DATA_DIR, BIN_DIR } = await import("../dist/config.js");
const { installTectonic, TECTONIC_VERSION } = await import("../dist/setup.js");
const { codexExecutable } = await import("../dist/backends/codex-client.js");

// 1. git — hard requirement: cloning, diffs, and the whole review flow use it.
if (!(await has("git"))) {
  console.error("blattbot: git is required but was not found on your PATH.");
  console.error("  Install it from https://git-scm.com (or `apt install git`, `brew install git`, winget) and retry.");
  process.exit(1);
}

// 2. TeX engine — offer to download tectonic into the data dir when missing.
const manualTexHint = () => {
  console.log("  BlattBot still runs without a TeX engine, but compiles will fail until one is installed.");
  console.log("  Install latexmk/pdflatex (a TeX distribution) or tectonic (https://tectonic-typesetting.github.io),");
  console.log(`  or drop a tectonic binary into ${short(BIN_DIR)}.`);
};
let engine = await detectEngine();
if (!engine) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let download = args.yes;
  if (!download && interactive) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(
        `No TeX engine found. Download tectonic ${TECTONIC_VERSION} (~20 MB, one time) into ${short(BIN_DIR)}? [Y/n] `,
      )
    )
      .trim()
      .toLowerCase();
    rl.close();
    download = answer === "" || answer === "y" || answer === "yes";
  }
  if (download) {
    try {
      await installTectonic(BIN_DIR, { log: (line) => console.log(`  ${line}`) });
      resetEngineCache();
      engine = await detectEngine();
    } catch (err) {
      console.error(`  tectonic download failed: ${err?.message ?? err}`);
      manualTexHint();
    }
  } else {
    console.log(interactive ? "  Skipping the download." : "No TeX engine found (non-interactive — not prompting).");
    manualTexHint();
  }
}

// 3. The selected background harness — an installed CLI still needs a login.
const { loadSettings, selectedBackend } = await import("../dist/settings.js");
const backend = selectedBackend(loadSettings());
const harness = backend === "codex"
  ? (await has(codexExecutable()))
    ? "Codex found — uses your codex login; check connection in Settings → Agent"
    : "Codex not found — npm install -g @openai/codex, then codex login"
  : backend === "claude"
    ? "Claude Agent SDK — uses Claude Code login or the API key in Settings"
    : "OpenAI-compatible API — configured in Settings → Agent";

// ---- start -----------------------------------------------------------------

// A busy port: if another BlattBot holds it, open that one (unless --no-open)
// and exit 0; otherwise explain and exit 1. See src/listen.ts.
const { openBrowser, setOpenBrowserOnConflict } = await import("../dist/listen.js");
setOpenBrowserOnConflict(args.open);
const server = await import("../dist/index.js"); // resolves once the server is listening
const port = Number(process.env.BLATTBOT_PORT ?? 4560);
const url = `http://127.0.0.1:${port}`;

console.log("");
console.log(`  BlattBot v${pkg.version} — agentic LaTeX editing for Overleaf`);
console.log("");
console.log(`    App       ${url}`);
console.log(`    Data dir  ${short(DATA_DIR)}`);
console.log(`    TeX       ${engine ? `${engine.name} (${short(engine.path)})` : "none — compiles will fail until an engine is installed"}`);
console.log(`    Agent     ${harness}`);
console.log("");
console.log("  Press Ctrl+C to stop.");

// Best-effort browser open; never fails startup.
if (args.open) openBrowser(url);

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(1); // second Ctrl+C: force quit
  closing = true;
  console.log("\n  BlattBot stopped.");
  try {
    await server.app.close();
  } catch {
    /* sockets die with the process anyway */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
