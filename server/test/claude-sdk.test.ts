/**
 * The optional Claude Agent SDK (server/src/claude-sdk.ts): where it is found,
 * the on-demand install into the data directory, and that a missing SDK only
 * fails Claude turns, never module loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-sdk-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const noDependency = () => undefined;

/** What `npm install` leaves behind, with a stub module standing in for the SDK. */
function fakeNpm(version: string) {
  return vi.fn(async (_args: string[], cwd: string) => {
    const pkg = join(cwd, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version }));
    writeFileSync(join(pkg, "sdk.mjs"), "export const stub = 'managed copy'; export function query() {} export function tool() {} export function createSdkMcpServer() {}\n");
  });
}

describe("optional Claude Agent SDK", () => {
  it("pins the version the devDependency installs", async () => {
    const { CLAUDE_SDK_VERSION, locateClaudeSdk } = await import("../src/claude-sdk.js");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
    expect(pkg.devDependencies["@anthropic-ai/claude-agent-sdk"]).toBe(CLAUDE_SDK_VERSION);
    expect(locateClaudeSdk()).toMatchObject({ source: "dependency", version: CLAUDE_SDK_VERSION });
  });

  it("reports a missing SDK and refuses to load it with instructions", async () => {
    const { ClaudeSdkMissingError, claudeSdkStatus, loadClaudeSdk, locateClaudeSdk } = await import("../src/claude-sdk.js");
    expect(locateClaudeSdk(noDependency)).toBeNull();
    const status = claudeSdkStatus(null);
    expect(status).toMatchObject({ installed: false, installing: false, pinnedVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(status.message).toContain("Not installed");
    const error = await loadClaudeSdk(null).catch((e) => e);
    expect(error).toBeInstanceOf(ClaudeSdkMissingError);
    expect(error.message).toContain("Settings → Agent");
  });

  it("installs the pinned version into the data directory and loads it from there", async () => {
    const sdk = await import("../src/claude-sdk.js");
    const rootDir = sdk.managedSdkRoot();
    mkdirSync(join(rootDir, "0.3.100", "node_modules"), { recursive: true });
    mkdirSync(join(rootDir, ".staging-interrupted"), { recursive: true });
    const npm = fakeNpm(sdk.CLAUDE_SDK_VERSION);
    // Concurrent requests share one npm run.
    await Promise.all([sdk.installClaudeSdk(npm), sdk.installClaudeSdk(npm)]);
    expect(npm).toHaveBeenCalledTimes(1);
    const [args, cwd] = npm.mock.calls[0];
    expect(args).toEqual(sdk.NPM_INSTALL_ARGS);
    expect(args).toContain(`@anthropic-ai/claude-agent-sdk@${sdk.CLAUDE_SDK_VERSION}`);
    expect(args).toEqual(expect.arrayContaining(["--legacy-peer-deps", "--ignore-scripts", "--include=optional", "--global=false"]));
    expect(cwd.startsWith(join(rootDir, ".staging-"))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(rootDir, "0.3.100"))).toBe(false);
    expect(existsSync(join(rootDir, ".staging-interrupted"))).toBe(false);
    const location = sdk.locateClaudeSdk(noDependency);
    expect(location).toEqual({
      entry: join(sdk.managedSdkDir(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
      source: "managed",
      version: sdk.CLAUDE_SDK_VERSION,
    });
    expect(sdk.claudeSdkStatus(location)).toMatchObject({ installed: true, source: "managed", installing: false });
    expect(((await sdk.loadClaudeSdk(location)) as any).stub).toBe("managed copy");
  });

  it("keeps nothing from a failed or mismatched install and reports why", async () => {
    const sdk = await import("../src/claude-sdk.js");
    await expect(sdk.installClaudeSdk(async () => { throw new Error("E404 registry unreachable"); })).rejects.toThrow("E404");
    expect(sdk.claudeSdkStatus(null).error).toContain("E404");
    await expect(sdk.installClaudeSdk(fakeNpm("9.9.9"))).rejects.toThrow(`installed version 9.9.9 instead of ${sdk.CLAUDE_SDK_VERSION}`);
    expect(sdk.locateClaudeSdk(noDependency)).toBeNull();
    expect(existsSync(sdk.managedSdkDir())).toBe(false);
    await sdk.installClaudeSdk(fakeNpm(sdk.CLAUDE_SDK_VERSION));
    expect(sdk.claudeSdkStatus(null).error).toBeUndefined();
  });

  it("loads the backends without the SDK, and fails only the calls that need it", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => { throw new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'"); });
    const claude = await import("../src/backends/claude.js");
    const { listModels, staticModelList } = await import("../src/models.js");
    const { DEFAULT_SETTINGS } = await import("../src/settings.js");
    expect(claude.turnModelOptions("claude-sonnet-5", { effort: "", fallbackModel: "" })).toEqual({ model: "claude-sonnet-5" });
    // Node reports "Cannot find package"; vitest wraps the mock's error in its own message.
    await expect(claude.buildMcpServer({} as any)).rejects.toThrow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await listModels({ ...DEFAULT_SETTINGS, backend: "claude" })).models).toEqual(staticModelList().models);
    } finally { warn.mockRestore(); }
  });

  it("serves the status and skips installing when an SDK is already available", async () => {
    const Fastify = (await import("fastify")).default;
    const { registerClaudeSdkRoutes } = await import("../src/claude-sdk.js");
    const app = Fastify();
    const install = vi.fn(async () => {});
    registerClaudeSdkRoutes(app, install);
    const status = (await app.inject({ method: "GET", url: "/api/agent/claude-sdk" })).json();
    expect(status).toMatchObject({ installed: true, source: "dependency" });
    expect((await app.inject({ method: "POST", url: "/api/agent/claude-sdk/install" })).json()).toMatchObject({ installed: true });
    expect(install).not.toHaveBeenCalled();
    await app.close();
  });
});
