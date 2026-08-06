#!/usr/bin/env node
/**
 * BlattBot CLI (`npx blattbot`) — first-run checks, then start the local
 * server and open the app in the browser. Plain Node ESM over the compiled
 * server in ../dist; no TypeScript, no dependencies beyond node builtins.
 *
 *   blattbot            start (default)
 *   blattbot doctor     environment diagnostics
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const HELP = `BlattBot — agentic LaTeX editing for Overleaf, local-first.

Usage
  blattbot [options]     start the server and open the app
  blattbot doctor        print environment diagnostics

Options
  --port <n>        port to listen on (default 4560; env BLATTBOT_PORT)
  --data-dir <p>    data directory (default ~/.local/share/blattbot; env BLATTBOT_DATA_DIR)
  --no-open         do not open the browser
  -y, --yes         answer yes to prompts (e.g. the tectonic download)
  -v, --version     print the version
  -h, --help        show this help
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
  await runDoctor();
  process.exit(0);
}

// ---- first-run checks ------------------------------------------------------

const { detectEngine, resetEngineCache } = await import("../dist/compile.js");
const { DATA_DIR, BIN_DIR } = await import("../dist/config.js");
const { installTectonic, TECTONIC_VERSION } = await import("../dist/setup.js");

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

// 3. Claude Code CLI — informational; agent turns need it, everything else works.
const claude = await has("claude");

// ---- start -----------------------------------------------------------------

const server = await import("../dist/index.js"); // resolves once the server is listening
const port = Number(process.env.BLATTBOT_PORT ?? 4560);
const url = `http://127.0.0.1:${port}`;

console.log("");
console.log(`  BlattBot v${pkg.version} — agentic LaTeX editing for Overleaf`);
console.log("");
console.log(`    App       ${url}`);
console.log(`    Data dir  ${short(DATA_DIR)}`);
console.log(`    TeX       ${engine ? `${engine.name} (${short(engine.path)})` : "none — compiles will fail until an engine is installed"}`);
console.log(`    Claude    ${claude ? "claude CLI found — agent turns ready" : "claude CLI not found — install Claude Code and log in to run agent turns"}`);
console.log("");
console.log("  Press Ctrl+C to stop.");

if (args.open) {
  // Best-effort browser open; never fail startup over it.
  try {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

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
