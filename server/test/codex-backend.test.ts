import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "node:child_process";
import type { BackendTurnContext, AgentEvent } from "../src/backends/types.js";

vi.mock("../src/compile.js", () => ({ compileProject: vi.fn(async () => ({ ok: true, engine: "mock", durationMs: 1, mainTex: "main.tex" })) }));

let data: string;
let ctx: BackendTurnContext;
let events: AgentEvent[];
let controller: AbortController;
const log = () => readFileSync(join(data, "rpc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "blattbot-codex-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", data);
  vi.stubEnv("BLATTBOT_CODEX_EXECUTABLE", fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url)));
  vi.stubEnv("BLATTBOT_TEST_CODEX_LOG", join(data, "rpc.jsonl"));
  vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "edit");
  vi.resetModules();
  const { DEFAULT_SETTINGS } = await import("../src/settings.js");
  const { SYSTEM_APPEND } = await import("../src/backends/types.js");
  const config = await import("../src/config.js");
  const project = config.addProject({ name: "Codex test", gitUrl: "local", kind: "local" });
  const dir = config.projectDir(project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.tex"), "Original manuscript.\n");
  controller = new AbortController();
  events = [];
  ctx = { project, dir, prompt: "Revise the manuscript", systemAppend: SYSTEM_APPEND,
    settings: { ...DEFAULT_SETTINGS }, model: "", readOnly: false, contextDirs: [], attachments: [],
    session: { onSessionId: vi.fn() }, signal: controller.signal, emit: (event) => events.push(event) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Codex background harness", () => {
  it("waits for child process closure and supports repeated shutdown", async () => {
    const { CodexClient } = await import("../src/backends/codex-client.js");
    const client = new CodexClient();
    let closed = false;
    const kill = ChildProcess.prototype.kill;
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
      this.once("close", () => { closed = true; });
      return kill.call(this, signal);
    });
    try {
      await client.initialize();
      const closing = client.close();
      expect(client.close()).toBe(closing);
      await closing;
      expect(closed).toBe(true);
      await client.close();
      expect(killSpy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      killSpy.mockRestore();
    }
  });

  it("launches Windows npm installations through Node, without shell quoting", async () => {
    const { codexCommand } = await import("../src/backends/codex-client.js");
    const npmDir = join(data, "npm with spaces");
    const entry = join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(join(npmDir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(entry, "");
    expect(codexCommand("codex", "win32", `${join(data, "missing")};${npmDir}`)).toEqual({ command: process.execPath, args: [entry] });
    expect(codexCommand(join(data, "custom.exe"), "win32", npmDir)).toEqual({ command: join(data, "custom.exe"), args: [] });
  });
  it("keeps project model overrides with their harness and handles legacy Claude models", async () => {
    const { resolveBackendModel } = await import("../src/agent.js");
    const settings = { ...ctx.settings, codexModel: "codex-model", model: "sonnet" };
    expect(resolveBackendModel({ settings: { model: "fable" } }, settings)).toBe("codex-model");
    expect(resolveBackendModel({ settings: { model: "custom", modelBackend: "claude" } }, settings)).toBe("codex-model");
    expect(resolveBackendModel({ settings: { model: "custom", modelBackend: "codex" } }, settings)).toBe("custom");
  });
  it("runs a streamed turn through the default dispatcher, with edits and compile tools", async () => {
    const agent = await import("../src/agent.js");
    await agent.runTurn(ctx.project, ctx.prompt, ctx.emit, "edit", undefined, ctx.session);
    expect(agent.activeBackendId()).toBe("codex");
    expect(agent.isTurnActive(ctx.project.id)).toBe(false);
    expect(readFileSync(join(ctx.dir, "main.tex"), "utf8")).toBe("Revised manuscript.\n");
    expect(ctx.session.onSessionId).toHaveBeenCalledWith(expect.stringMatching(/^codex-/));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")).toBe("All done.");
    expect(events.filter((e) => e.type === "turn_end")).toEqual([expect.objectContaining({
      isError: false, model: "codex-test-model", inputTokens: 100, outputTokens: 20,
    })]);
    expect(events.some((e) => e.name === "mcp__blattbot__compile_latex")).toBe(true);
    const start = log().find((m) => m.method === "thread/start").params;
    expect(start).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "never" });
    expect(start.cwd).not.toBe(ctx.dir);
    expect(start.config.mcp_servers).toEqual({ "private.server": { command: "unused", enabled: false } });
    expect(Object.keys(start.config).some(k => k.startsWith("mcp_servers."))).toBe(false);
    expect(start.config["features.shell_tool"]).toBe(false);
    expect(start.dynamicTools.some((t: any) => t.name === "verify_citation_support")).toBe(true);
    expect(start.model).toBeUndefined(); // inherit Codex's configured model
  });

  it("resumes Codex sessions and counts only this turn's tokens", async () => {
    const { codexBackend, recordCodexToolset } = await import("../src/backends/codex.js");
    ctx.session.sessionId = "codex-01900000-0000-7000-8000-000000000001";
    recordCodexToolset(ctx.session.sessionId.slice(6));
    ctx.model = "custom-codex-model";
    ctx.settings.codexEffort = "high";
    await codexBackend.runTurn(ctx);
    expect(log().find((m) => m.method === "thread/resume").params.model).toBe("custom-codex-model");
    expect(log().find((m) => m.method === "turn/start").params.effort).toBe("high");
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(ctx.session.onSessionId).not.toHaveBeenCalled();
  });

  it("upgrades an older session's fixed tool catalog and carries recent conversation text", async () => {
    const { codexBackend } = await import("../src/backends/codex.js");
    const { createChat, updateChat, appendEvent } = await import("../src/chats.js");
    ctx.session.sessionId = "codex-01900000-0000-7000-8000-000000000001";
    const chat = createChat(ctx.project.id);
    updateChat(ctx.project.id, chat.id, { sessionId: ctx.session.sessionId });
    appendEvent(ctx.project.id, chat.id, { type: "user_message", text: "Compare graph models and their limitations." });
    await codexBackend.runTurn(ctx);
    const start = log().find((message) => message.method === "thread/start").params;
    expect(start.dynamicTools.some((tool: any) => tool.name === "read_paper")).toBe(true);
    expect(log().find((message) => message.method === "turn/start").params.input[0].text).toContain("Compare graph models");
    expect(ctx.session.onSessionId).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", text: expect.stringContaining("paper-reading tools") }));
  });

  it("starts a separate Codex conversation when switching from Claude", async () => {
    const { codexBackend } = await import("../src/backends/codex.js");
    ctx.session.sessionId = "claude-session";
    await codexBackend.runTurn(ctx);
    expect(log().some((m) => m.method === "thread/resume")).toBe(false);
    expect(events.some((e) => e.type === "notice" && String(e.text).includes("memory"))).toBe(true);
  });

  it("rejects write and citation requests in read-only mode, including resumed tool catalogs", async () => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "readonly");
    const { codexBackend } = await import("../src/backends/codex.js");
    ctx.readOnly = true;
    ctx.session.sessionId = "codex-01900000-0000-7000-8000-000000000001";
    await codexBackend.runTurn(ctx);
    expect(readFileSync(join(ctx.dir, "main.tex"), "utf8")).toBe("Original manuscript.\n");
    expect(log().filter((m) => m.result?.success === false)).toHaveLength(2);
  });

  it("updates host editing permissions when the same read-only chat switches to Edit and back", async () => {
    const { codexBackend } = await import("../src/backends/codex.js");
    ctx.session.onSessionId = id => { ctx.session.sessionId = id; };

    ctx.readOnly = true;
    await codexBackend.runTurn(ctx);
    expect(readFileSync(join(ctx.dir, "main.tex"), "utf8")).toBe("Original manuscript.\n");

    ctx.readOnly = false;
    await codexBackend.runTurn(ctx);
    expect(readFileSync(join(ctx.dir, "main.tex"), "utf8")).toBe("Revised manuscript.\n");

    writeFileSync(join(ctx.dir, "main.tex"), "User's subsequent edit.\n");
    ctx.readOnly = true;
    await codexBackend.runTurn(ctx);
    expect(readFileSync(join(ctx.dir, "main.tex"), "utf8")).toBe("User's subsequent edit.\n");

    const starts = log().filter(m => m.method === "thread/start" || m.method === "thread/resume");
    expect(starts.map(m => m.method)).toEqual(["thread/start", "thread/resume", "thread/resume"]);
    expect(starts.map(m => m.params.sandbox)).toEqual(["read-only", "workspace-write", "read-only"]);
    expect(starts[1].params.config.sandbox_workspace_write).toEqual({
      writable_roots: [ctx.dir], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
    });
    expect(starts.every(m => m.params.config["features.shell_tool"] === false)).toBe(true);
    const turns = log().filter(m => m.method === "turn/start");
    expect(turns.map(m => m.params.sandboxPolicy.type)).toEqual(["readOnly", "workspaceWrite", "readOnly"]);
    expect(turns[1].params.sandboxPolicy).toEqual({
      type: "workspaceWrite", writableRoots: [ctx.dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    });
    for (const [index, permission] of ["DISABLED", "ENABLED", "DISABLED"].entries()) {
      expect(starts[index].params.developerInstructions).toContain(`project editing is ${permission}`);
      expect(turns[index].params.input[0].text).toContain(`project editing is ${permission}`);
    }
    expect(log().filter(m => m.result?.success === false)).toHaveLength(2);
  });

  it("carries images as local image inputs", async () => {
    const { codexBackend } = await import("../src/backends/codex.js");
    ctx.attachments = [{ path: join(data, "image.png"), mime: "image/png" } as any];
    await codexBackend.runTurn(ctx);
    expect(log().find((m) => m.method === "turn/start").params.input[1]).toEqual({ type: "localImage", path: join(data, "image.png") });
  });

  it("answers questions through the existing chat question flow", async () => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "question");
    const { codexBackend } = await import("../src/backends/codex.js");
    const questions = await import("../src/questions.js");
    ctx.emit = (event) => {
      events.push(event);
      if (event.type === "question") questions.answerQuestion(ctx.project.id, String(event.questionId), { "Which style?": "Concise" });
    };
    await codexBackend.runTurn(ctx);
    expect(events.some((e) => e.type === "question_answered")).toBe(true);
  });

  it.each(["error", "exit"])("surfaces %s failures and closes the process", async (scenario) => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", scenario);
    const { codexBackend } = await import("../src/backends/codex.js");
    await expect(codexBackend.runTurn(ctx)).rejects.toThrow(scenario === "error" ? /provider failure/ : /exited/);
    expect(events.some((e) => e.type === "turn_end" && e.isError === false)).toBe(false);
  });

  it("interrupts a stalled turn", async () => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "hang");
    const { codexBackend } = await import("../src/backends/codex.js");
    ctx.emit = (e) => { if (e.type === "thinking") setTimeout(() => controller.abort(), 20); };
    await expect(codexBackend.runTurn(ctx)).rejects.toThrow(/interrupt|closed|abort/i);
  });

  it("reports an actionable missing-CLI error", async () => {
    vi.stubEnv("BLATTBOT_CODEX_EXECUTABLE", join(data, "does-not-exist"));
    const { codexBackend } = await import("../src/backends/codex.js");
    await expect(codexBackend.runTurn(ctx)).rejects.toThrow(/Install @openai\/codex/);
  });

  it("uses Codex for ephemeral, tool-less one-shot calls too", async () => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "oneshot");
    const { runOneShot } = await import("../src/agent.js");
    expect(await runOneShot("Summarize this paper")).toBe("All done.");
    expect(log().find((m) => m.method === "thread/start").params).toMatchObject({ ephemeral: true, dynamicTools: [] });
    expect(log().find((m) => m.method === "turn/start").params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("checks installation, login, and the model catalog without starting a turn", async () => {
    const { codexStatus } = await import("../src/codexinfo.js");
    expect(await codexStatus()).toMatchObject({ available: true, authenticated: true, defaultModel: "codex-test-model" });
    expect(log().some((m) => m.method === "thread/start" || m.method === "turn/start")).toBe(false);
  });

  it("distinguishes an installed CLI from an authenticated one", async () => {
    vi.stubEnv("BLATTBOT_TEST_CODEX_SCENARIO", "loggedout");
    const { codexStatus } = await import("../src/codexinfo.js");
    expect(await codexStatus()).toMatchObject({ available: true, authenticated: false, message: expect.stringContaining("codex login") });
  });
});

describe("shared Codex/OpenAI file boundary", () => {
  it("blocks symlinked reads, writes, and new files below symlinked directories", async () => {
    const { resolveReadPath, resolveWritePath } = await import("../src/backends/openai.js");
    const outside = join(data, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.tex"), "secret");
    symlinkSync(outside, join(ctx.dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveReadPath(ctx.dir, [], "linked/secret.tex")).toThrow(/symbolic/);
    expect(() => resolveWritePath(ctx.dir, [], "linked/new.tex")).toThrow(/symbolic/);
    expect(() => resolveReadPath(ctx.dir, [], ".git/config")).toThrow(/off-limits/);
    const { listFiles } = await import("../src/latex.js");
    expect(listFiles(ctx.dir)).toEqual(["main.tex"]);
  });
});
