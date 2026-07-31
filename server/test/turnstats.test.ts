/**
 * Cost/token transparency: the Claude backend's usage extraction, the openai
 * stream accumulator's usage chunk, and the chats store folding turn_end
 * events into per-chat and per-project cumulative totals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-turnstats-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("claude result usage extraction", () => {
  it("reads cost and sums fresh + cache tokens from a SDK result message", async () => {
    const { extractResultUsage } = await import("../src/backends/claude.js");
    const m = {
      type: "result",
      is_error: false,
      total_cost_usd: 0.3215,
      duration_ms: 5000,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 888,
        output_tokens: 345,
      },
    };
    expect(extractResultUsage(m)).toEqual({ costUsd: 0.3215, inputTokens: 1000, outputTokens: 345 });
  });

  it("leaves absent or malformed fields undefined", async () => {
    const { extractResultUsage } = await import("../src/backends/claude.js");
    expect(extractResultUsage({ total_cost_usd: 0.5 })).toEqual({ costUsd: 0.5 });
    expect(extractResultUsage({ usage: { output_tokens: 7 } })).toEqual({ outputTokens: 7 });
    // Partial usage still sums what is there.
    expect(extractResultUsage({ usage: { input_tokens: 3 } })).toEqual({ inputTokens: 3 });
    expect(extractResultUsage({ total_cost_usd: "free", usage: { input_tokens: "many" } })).toEqual({});
    expect(extractResultUsage(null)).toEqual({});
    expect(extractResultUsage({})).toEqual({});
  });
});

describe("openai stream usage folding", () => {
  const noop = { onTextDelta: () => {}, onThinking: () => {}, onToolStart: () => {} };

  it("captures the usage chunk even though its choices array is empty", async () => {
    const { foldChunk } = await import("../src/backends/openai.js");
    const acc = { content: "", calls: new Map(), finishReason: null, usage: null } as any;
    foldChunk(acc, { choices: [{ delta: { content: "hi" } }] }, noop);
    expect(acc.usage).toBeNull();
    foldChunk(acc, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 45 } }, noop);
    expect(acc.usage).toEqual({ promptTokens: 120, completionTokens: 45 });
    // A later chunk without usage does not clear it.
    foldChunk(acc, { choices: [{ delta: {}, finish_reason: "stop" }] }, noop);
    expect(acc.usage).toEqual({ promptTokens: 120, completionTokens: 45 });
    expect(acc.content).toBe("hi");
    expect(acc.finishReason).toBe("stop");
  });

  it("ignores malformed usage objects", async () => {
    const { foldChunk } = await import("../src/backends/openai.js");
    const acc = { content: "", calls: new Map(), finishReason: null, usage: null } as any;
    foldChunk(acc, { usage: { prompt_tokens: "lots" } }, noop);
    foldChunk(acc, { usage: {} }, noop);
    foldChunk(acc, { usage: null }, noop);
    expect(acc.usage).toBeNull();
    // One numeric field is enough; the other defaults to 0.
    foldChunk(acc, { usage: { completion_tokens: 9 } }, noop);
    expect(acc.usage).toEqual({ promptTokens: 0, completionTokens: 9 });
  });
});

describe("chat & project cumulative stats", () => {
  async function load() {
    const config = await import("../src/config.js");
    const chats = await import("../src/chats.js");
    return { config, chats };
  }

  it("folds turn_end cost and tokens into the chat's and the project's totals", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Stats", gitUrl: "", kind: "local" });
    const chat = chats.createChat(p.id);

    chats.appendEvent(p.id, chat.id, {
      type: "turn_end",
      isError: false,
      costUsd: 0.25,
      inputTokens: 1000,
      outputTokens: 200,
    });
    chats.appendEvent(p.id, chat.id, {
      type: "turn_end",
      isError: false,
      costUsd: 0.05,
      inputTokens: 400,
      outputTokens: 100,
    });

    const meta = chats.getChat(p.id, chat.id)!;
    expect(meta.stats).toEqual({ costUsd: 0.3, inputTokens: 1400, outputTokens: 300, turns: 2 });
    const project = config.getProject(p.id)!;
    expect(project.stats).toEqual({ totalCostUsd: 0.3, totalTurns: 2 });
    // The public views keep the stats (they are not secrets).
    expect(chats.publicChat(meta).stats).toEqual(meta.stats);
    expect(config.publicProject(project).stats).toEqual(project.stats);
  });

  it("counts cost-less turns and skips interrupted ones", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Stats2", gitUrl: "", kind: "local" });
    const chat = chats.createChat(p.id);

    // An openai turn: tokens but no cost.
    chats.appendEvent(p.id, chat.id, {
      type: "turn_end",
      isError: false,
      inputTokens: 50,
      outputTokens: 10,
    });
    // A bare error turn: nothing but the flag.
    chats.appendEvent(p.id, chat.id, { type: "turn_end", isError: true });
    // Interrupted turns do not count.
    chats.appendEvent(p.id, chat.id, { type: "turn_end", isError: false, interrupted: true });

    expect(chats.getChat(p.id, chat.id)!.stats).toEqual({
      costUsd: 0,
      inputTokens: 50,
      outputTokens: 10,
      turns: 2,
    });
    expect(config.getProject(p.id)!.stats).toEqual({ totalCostUsd: 0, totalTurns: 2 });
  });

  it("aggregates across chats of the same project and tolerates unknown projects", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Stats3", gitUrl: "", kind: "local" });
    const a = chats.createChat(p.id);
    const b = chats.createChat(p.id);
    chats.appendEvent(p.id, a.id, { type: "turn_end", isError: false, costUsd: 0.1 });
    chats.appendEvent(p.id, b.id, { type: "turn_end", isError: false, costUsd: 0.2 });
    expect(config.getProject(p.id)!.stats).toEqual({ totalCostUsd: 0.30000000000000004, totalTurns: 2 });
    expect(chats.getChat(p.id, a.id)!.stats!.turns).toBe(1);
    expect(chats.getChat(p.id, b.id)!.stats!.turns).toBe(1);

    // Chats without a registered project still track their own totals.
    const orphan = chats.createChat("no-such-project");
    chats.appendEvent("no-such-project", orphan.id, { type: "turn_end", isError: false, costUsd: 1 });
    expect(chats.getChat("no-such-project", orphan.id)!.stats!.costUsd).toBe(1);
  });

  it("non-turn_end events leave the stats untouched", async () => {
    const { config, chats } = await load();
    const p = config.addProject({ name: "Stats4", gitUrl: "", kind: "local" });
    const chat = chats.createChat(p.id);
    chats.appendEvent(p.id, chat.id, { type: "user_message", text: "hi", mode: "edit" });
    chats.appendEvent(p.id, chat.id, { type: "text_final", text: "hello" });
    expect(chats.getChat(p.id, chat.id)!.stats).toBeUndefined();
    expect(config.getProject(p.id)!.stats).toBeUndefined();
  });
});
