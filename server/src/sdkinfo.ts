/**
 * Which Claude Code engine the Agent SDK will spawn, and which SDK version
 * this is — for `blattbot doctor` and the transparency tab.
 *
 * Since SDK 0.3 the CLI ships as a platform-specific native binary in an
 * optional dependency (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 * ~230 MB, picked by npm for the installing machine). The SDK itself is
 * optional (claude-sdk.ts). BLATTBOT_CLAUDE_EXECUTABLE points the SDK at
 * another `claude` binary instead — for people who would rather reuse a
 * global Claude Code install and skip the bundled one.
 */
import { existsSync } from "node:fs";
import { locateClaudeSdk, platformBinary } from "./claude-sdk.js";

export const EXECUTABLE_ENV = "BLATTBOT_CLAUDE_EXECUTABLE";

/** The version of the SDK the Claude backend would load (see claude-sdk.ts), if any. */
export function agentSdkVersion(): string | undefined {
  return locateClaudeSdk()?.version;
}

/** The Claude Code binary that came with that SDK, when npm installed one for this platform. */
export function bundledExecutable(): string | undefined {
  const sdk = locateClaudeSdk();
  return sdk ? platformBinary(sdk.entry) : undefined;
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
  if (!locateClaudeSdk()) return "the Claude Agent SDK is not installed — install it in Settings → Agent";
  const bundled = bundledExecutable();
  return bundled
    ? `bundled with the Agent SDK (${bundled})`
    : `no bundled binary for ${process.platform}-${process.arch} — set ${EXECUTABLE_ENV} to a claude binary`;
}
