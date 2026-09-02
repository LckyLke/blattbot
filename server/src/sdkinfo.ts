/**
 * Which Claude Code engine the Agent SDK will spawn, and which SDK version
 * this is — for `blattbot doctor` and the transparency tab.
 *
 * Since SDK 0.3 the CLI ships as a platform-specific native binary in an
 * optional dependency (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 * ~200 MB, picked by npm for the installing machine). BLATTBOT_CLAUDE_EXECUTABLE
 * points the SDK at another `claude` binary instead — for people who would
 * rather reuse a global Claude Code install and skip the bundled one.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const EXECUTABLE_ENV = "BLATTBOT_CLAUDE_EXECUTABLE";

/**
 * The installed SDK's version. Its exports map does not expose package.json,
 * so the manifest is read next to the resolved entry point instead.
 */
export function agentSdkVersion(): string | undefined {
  const entry = resolveSdkEntry();
  if (!entry) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** The SDK's entry file: CJS resolution honours its "default" export condition; ESM as the fallback. */
function resolveSdkEntry(): string | undefined {
  try {
    return require.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    /* fall through */
  }
  try {
    return fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  } catch {
    return undefined;
  }
}

/** The bundled binary for this platform, when npm installed it. */
export function bundledExecutable(): string | undefined {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const dir = dirname(require.resolve(`${pkg}/package.json`));
    const bin = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** The override from the environment, when set (verbatim — the SDK validates it). */
export function executableOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[EXECUTABLE_ENV]?.trim();
  return v || undefined;
}

/**
 * The SDK query options that pick the engine: only the override is passed
 * explicitly — without it the SDK resolves its bundled binary itself.
 */
export function executableOptions(env: NodeJS.ProcessEnv = process.env): {
  pathToClaudeCodeExecutable?: string;
} {
  const override = executableOverride(env);
  return override ? { pathToClaudeCodeExecutable: override } : {};
}

/** One human line for doctor: which engine runs, and where it comes from. */
export function describeEngine(env: NodeJS.ProcessEnv = process.env): string {
  const override = executableOverride(env);
  if (override) {
    return `${override} (${EXECUTABLE_ENV})${existsSync(override) ? "" : " — NOT FOUND"}`;
  }
  const bundled = bundledExecutable();
  return bundled
    ? `bundled with the Agent SDK (${bundled})`
    : `no bundled binary for ${process.platform}-${process.arch} — set ${EXECUTABLE_ENV} to a claude binary`;
}
