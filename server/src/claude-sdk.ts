/**
 * The Claude Agent SDK is optional. Codex is the default backend, and the SDK
 * brings a native Claude Code binary of about 230 MB, so BlattBot does not
 * depend on it. The Claude backend loads it on first use from, in order:
 *
 *  1. normal module resolution: a development checkout (where it is a
 *     devDependency), or a copy the user installed next to BlattBot, e.g.
 *     `npm install -g @anthropic-ai/claude-agent-sdk@<version>` beside a global
 *     `blattbot`;
 *  2. DATA_DIR/claude-agent-sdk/<CLAUDE_SDK_VERSION>, which Settings → Agent
 *     installs on request (installClaudeSdk).
 *
 * The SDK bundles its own zod and MCP server code and imports only Node
 * builtins, so it is installed without its peer dependencies. Tool schemas
 * built with BlattBot's zod convert the same way from either location: the
 * MCP tool catalogs match, and the CLI registers every tool (checked against
 * 0.3.278 when this was written). The SDK finds its native binary relative to
 * its own files, so a copy in the data directory brings its own engine.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "./config.js";

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** The version BlattBot installs. Keep it equal to the devDependency in server/package.json (a test checks). */
export const CLAUDE_SDK_VERSION = "0.3.278";
/** The SDK plus this platform's Claude Code binary. */
export const CLAUDE_SDK_DOWNLOAD = "about 230 MB";

export type ClaudeSdk = typeof import("@anthropic-ai/claude-agent-sdk");

const require = createRequire(import.meta.url);

export function managedSdkRoot(): string {
  return join(DATA_DIR, "claude-agent-sdk");
}

export function managedSdkDir(version = CLAUDE_SDK_VERSION): string {
  return join(managedSdkRoot(), version);
}

const managedEntry = (dir: string) => join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");

export interface SdkLocation {
  /** The SDK's entry file. */
  entry: string;
  source: "dependency" | "managed";
  version?: string;
}

/** The version next to an entry file (the SDK's exports map hides package.json). */
function packageVersion(entry: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** CJS resolution honours the SDK's "default" export condition; ESM resolution as the fallback. */
export function resolveSdkDependency(): string | undefined {
  try {
    return require.resolve(CLAUDE_SDK_PACKAGE);
  } catch {
    /* not installed alongside BlattBot */
  }
  try {
    return fileURLToPath(import.meta.resolve(CLAUDE_SDK_PACKAGE));
  } catch {
    return undefined;
  }
}

/** Where the SDK would be loaded from, or null when it is not installed. */
export function locateClaudeSdk(resolveDependency: () => string | undefined = resolveSdkDependency): SdkLocation | null {
  const dependency = resolveDependency();
  if (dependency) return { entry: dependency, source: "dependency", version: packageVersion(dependency) };
  const managed = managedEntry(managedSdkDir());
  if (existsSync(managed)) return { entry: managed, source: "managed", version: packageVersion(managed) };
  return null;
}

/** The Claude Code binary that came with the SDK at `entry`, as the SDK itself looks it up. */
export function platformBinary(entry: string): string | undefined {
  const base = `${CLAUDE_SDK_PACKAGE}-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const from = createRequire(entry);
  for (const pkg of process.platform === "linux" ? [base, `${base}-musl`] : [base]) {
    try {
      const bin = join(dirname(from.resolve(`${pkg}/package.json`)), exe);
      if (existsSync(bin)) return bin;
    } catch {
      /* not this variant */
    }
  }
  return undefined;
}

export class ClaudeSdkMissingError extends Error {
  constructor() {
    super(
      `The Claude backend needs the Claude Agent SDK (${CLAUDE_SDK_PACKAGE}), which is not installed. ` +
        `Install it in Settings → Agent (${CLAUDE_SDK_DOWNLOAD}), or switch to the Codex backend.`,
    );
    this.name = "ClaudeSdkMissingError";
  }
}

const loaded = new Map<string, Promise<ClaudeSdk>>();

/** The SDK module, imported on first use. Throws ClaudeSdkMissingError when it is not installed. */
export function loadClaudeSdk(location: SdkLocation | null = locateClaudeSdk()): Promise<ClaudeSdk> {
  if (!location) return Promise.reject(new ClaudeSdkMissingError());
  let sdk = loaded.get(location.entry);
  if (!sdk) {
    sdk = (location.source === "dependency"
      ? import("@anthropic-ai/claude-agent-sdk")
      : import(pathToFileURL(location.entry).href)) as Promise<ClaudeSdk>;
    loaded.set(location.entry, sdk);
    sdk.catch(() => loaded.delete(location.entry));
  }
  return sdk;
}

export interface ClaudeSdkStatus {
  installed: boolean;
  version?: string;
  source?: SdkLocation["source"];
  /** The SDK's folder. */
  location?: string;
  /** The Claude Code binary that came with it; absent when none matches this platform. */
  binary?: string;
  /** The version Settings → Agent installs. */
  pinnedVersion: string;
  download: string;
  installing: boolean;
  /** Why the last install failed. */
  error?: string;
  /** One line for doctor and Settings → Agent. */
  message: string;
}

let installing: Promise<void> | undefined;
let lastError: string | undefined;

export function claudeSdkStatus(location: SdkLocation | null = locateClaudeSdk()): ClaudeSdkStatus {
  const binary = location ? platformBinary(location.entry) : undefined;
  const where = location?.source === "managed" ? `installed by BlattBot in ${dirname(location.entry)}` : "installed alongside BlattBot";
  const message = location
    ? `Claude Agent SDK ${location.version ?? "(unknown version)"} ${where}.` +
      (location.version && location.version !== CLAUDE_SDK_VERSION ? ` BlattBot is tested with ${CLAUDE_SDK_VERSION}.` : "") +
      (binary ? "" : ` It has no Claude Code binary for ${process.platform}-${process.arch}; set BLATTBOT_CLAUDE_EXECUTABLE to a claude binary.`)
    : `Not installed. Only the Claude backend needs it; installing downloads ${CLAUDE_SDK_DOWNLOAD} ` +
      `(the SDK and the Claude Code engine for this platform) into BlattBot's data folder.`;
  return {
    installed: Boolean(location),
    ...(location ? { version: location.version, source: location.source, location: dirname(location.entry) } : {}),
    ...(binary ? { binary } : {}),
    pinnedVersion: CLAUDE_SDK_VERSION,
    download: CLAUDE_SDK_DOWNLOAD,
    installing: Boolean(installing),
    ...(lastError ? { error: lastError } : {}),
    message,
  };
}

/** Runs npm with fixed arguments (no paths, nothing user-supplied) in `cwd`. */
export type NpmRunner = (args: string[], cwd: string) => Promise<void>;

/** npm's own entry next to the running node, so no shell is involved. */
function npmCli(): string | undefined {
  const fromEnv = process.env.npm_execpath;
  const candidates = [
    ...(fromEnv && /npm-cli\.[cm]?js$/.test(fromEnv) ? [fromEnv] : []),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((path) => existsSync(path));
}

const runNpm: NpmRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    // Settings inherited from an `npx blattbot` parent must not redirect the
    // install to a global or other prefix.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^npm_config_(global|prefix|location)$/i.test(key)) delete env[key];
    const cli = npmCli();
    const windows = process.platform === "win32";
    execFile(
      cli ? process.execPath : windows ? "npm.cmd" : "npm",
      cli ? [cli, ...args] : args,
      // Without npm-cli.js, Windows can only start npm.cmd through a shell; the arguments contain no paths or spaces.
      { cwd, env, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: !cli && windows },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`npm was not found. Install Node.js with npm, or run: npm install -g ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`));
        }
        const detail = String(stderr || error.message).trim().split("\n").slice(-8).join("\n");
        reject(new Error(detail || "npm install failed"));
      },
    );
  });

/** The npm arguments for the pinned SDK: optional binary included, no peers, no install scripts. */
export const NPM_INSTALL_ARGS = [
  "install",
  "--global=false",
  "--no-audit",
  "--no-fund",
  "--ignore-scripts",
  "--legacy-peer-deps",
  "--include=optional",
  "--save-exact",
  `${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`,
];

async function runInstall(run: NpmRunner): Promise<void> {
  const root = managedSdkRoot();
  mkdirSync(root, { recursive: true });
  // Leftovers of an install that was interrupted.
  for (const name of readdirSync(root)) if (name.startsWith(".staging-")) rmSync(join(root, name), { recursive: true, force: true });
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    mkdirSync(staging);
    writeFileSync(
      join(staging, "package.json"),
      JSON.stringify({ name: "blattbot-claude-agent-sdk", private: true, description: "Installed by BlattBot from Settings → Agent. Safe to delete." }, null, 2),
    );
    await run(NPM_INSTALL_ARGS, staging);
    const entry = managedEntry(staging);
    if (!existsSync(entry)) throw new Error("npm finished, but the SDK is missing from the install folder.");
    const version = packageVersion(entry);
    if (version !== CLAUDE_SDK_VERSION) throw new Error(`npm installed version ${version ?? "(unknown)"} instead of ${CLAUDE_SDK_VERSION}.`);
    const target = managedSdkDir();
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  // Copies of earlier pinned versions are BlattBot's own downloads, now superseded.
  for (const name of readdirSync(root)) {
    if (/^\d+\.\d+\.\d+/.test(name) && name !== CLAUDE_SDK_VERSION) rmSync(join(root, name), { recursive: true, force: true });
  }
}

/** Install the pinned SDK into the data directory. Concurrent calls share one run. */
export function installClaudeSdk(run: NpmRunner = runNpm): Promise<void> {
  installing ??= runInstall(run).then(
    () => { lastError = undefined; },
    (error: any) => {
      lastError = error?.message ?? String(error);
      throw error;
    },
  ).finally(() => { installing = undefined; });
  return installing;
}

/** GET status; POST install (a no-op when the SDK is already available). */
export function registerClaudeSdkRoutes(app: FastifyInstance, install: () => Promise<void> = installClaudeSdk): void {
  app.get("/api/agent/claude-sdk", async () => claudeSdkStatus());
  app.post("/api/agent/claude-sdk/install", async (_req, reply) => {
    if (locateClaudeSdk()) return claudeSdkStatus();
    try {
      await install();
      return claudeSdkStatus();
    } catch (error: any) {
      return reply.code(500).send({ error: `Installing the Claude Agent SDK failed: ${error?.message ?? error}`, status: claudeSdkStatus() });
    }
  });
}
