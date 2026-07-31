/**
 * AI-use disclosure aggregation: fixture transcripts → deterministic facts,
 * and the composed fallback paragraph. The polish step (runOneShot) is a
 * route concern and is deliberately not exercised here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-disclosure-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  const config = await import("../src/config.js");
  const chats = await import("../src/chats.js");
  const disclosure = await import("../src/disclosure.js");
  return { config, chats, disclosure };
}

describe("collectDisclosureFacts", () => {
  it("aggregates turns, modes, models, and touched files across chats", async () => {
    const { config, chats, disclosure } = await load();
    const p = config.addProject({ name: "Paper", gitUrl: "", kind: "local" });

    const a = chats.createChat(p.id);
    chats.appendEvent(p.id, a.id, { type: "user_message", text: "Fix the intro", mode: "edit" });
    chats.appendEvent(p.id, a.id, { type: "tool_use", id: "t1", name: "Read", detail: "main.tex" });
    chats.appendEvent(p.id, a.id, { type: "tool_use", id: "t2", name: "Edit", detail: "main.tex" });
    chats.appendEvent(p.id, a.id, { type: "tool_use", id: "t3", name: "Write", detail: "sections/intro.tex" });
    // The same file edited twice counts once.
    chats.appendEvent(p.id, a.id, { type: "tool_use", id: "t4", name: "Edit", detail: "main.tex" });
    chats.appendEvent(p.id, a.id, {
      type: "turn_end",
      isError: false,
      costUsd: 0.1,
      model: "claude-sonnet-5",
    });

    const b = chats.createChat(p.id);
    chats.appendEvent(p.id, b.id, { type: "user_message", text: "Find citations", mode: "research" });
    chats.appendEvent(p.id, b.id, { type: "turn_end", isError: false, model: "llama-3.3-70b" });
    // Interrupted turns are not completed turns.
    chats.appendEvent(p.id, b.id, { type: "turn_end", isError: false, interrupted: true });
    // A second message in an already-counted mode does not duplicate it.
    chats.appendEvent(p.id, b.id, { type: "user_message", text: "More citations", mode: "research" });

    // A never-used chat neither counts nor bounds the date range.
    chats.createChat(p.id);

    const facts = disclosure.collectDisclosureFacts(p.id);
    expect(facts.turns).toBe(2);
    expect(facts.chats).toBe(2);
    expect(facts.modes).toEqual(["edit", "research"]);
    expect(facts.models).toEqual(["claude-sonnet-5", "llama-3.3-70b"]);
    expect(facts.filesTouched).toBe(2);
    expect(facts.firstUse).toBe(a.createdAt);
    expect(typeof facts.lastUse).toBe("string");
    expect(facts.lastUse! >= facts.firstUse!).toBe(true);
  });

  it("returns empty facts for a project without any usage", async () => {
    const { config, chats, disclosure } = await load();
    const p = config.addProject({ name: "Untouched", gitUrl: "", kind: "local" });
    chats.createChat(p.id); // exists, but nothing happened in it
    expect(disclosure.collectDisclosureFacts(p.id)).toEqual({
      turns: 0,
      chats: 0,
      modes: [],
      models: [],
      filesTouched: 0,
      firstUse: null,
      lastUse: null,
    });
  });

  it("tolerates malformed events without a mode, model, or detail", async () => {
    const { config, chats, disclosure } = await load();
    const p = config.addProject({ name: "Odd", gitUrl: "", kind: "local" });
    const chat = chats.createChat(p.id);
    chats.appendEvent(p.id, chat.id, { type: "user_message", text: "hi" }); // no mode
    chats.appendEvent(p.id, chat.id, { type: "tool_use", id: "x", name: "Edit" }); // no detail
    chats.appendEvent(p.id, chat.id, { type: "tool_end" }); // unknown type
    chats.appendEvent(p.id, chat.id, { type: "turn_end", isError: false }); // no model
    const facts = disclosure.collectDisclosureFacts(p.id);
    expect(facts.turns).toBe(1);
    expect(facts.chats).toBe(1);
    expect(facts.modes).toEqual([]);
    expect(facts.models).toEqual([]);
    expect(facts.filesTouched).toBe(0);
  });
});

describe("composeDisclosure", () => {
  const base = {
    turns: 0,
    chats: 0,
    modes: [] as string[],
    models: [] as string[],
    filesTouched: 0,
    firstUse: null as string | null,
    lastUse: null as string | null,
  };

  it("states plainly when nothing is recorded", async () => {
    const { disclosure } = await load();
    const text = disclosure.composeDisclosure("My Paper", base);
    expect(text).toContain('"My Paper"');
    expect(text).toMatch(/No AI assistance is recorded/);
  });

  it("composes a factual paragraph from full facts, deterministically", async () => {
    const { disclosure } = await load();
    const facts = {
      ...base,
      turns: 12,
      chats: 3,
      modes: ["edit", "research"],
      models: ["claude-sonnet-5"],
      filesTouched: 4,
      firstUse: "2026-06-01T10:00:00.000Z",
      lastUse: "2026-07-15T18:30:00.000Z",
    };
    const text = disclosure.composeDisclosure("My Paper", facts);
    expect(text).toContain("12 agent turns");
    expect(text).toContain("between 2026-06-01 and 2026-07-15");
    expect(text).toContain("edit, research");
    expect(text).toContain("claude-sonnet-5");
    expect(text).toContain("4 project files");
    expect(text).toMatch(/reviewable diff/);
    // Same facts, same paragraph.
    expect(disclosure.composeDisclosure("My Paper", facts)).toBe(text);
  });

  it("handles singulars, single-day ranges, and zero file edits", async () => {
    const { disclosure } = await load();
    const facts = {
      ...base,
      turns: 1,
      chats: 1,
      modes: ["review"],
      models: [],
      filesTouched: 0,
      firstUse: "2026-07-30T08:00:00.000Z",
      lastUse: "2026-07-30T09:00:00.000Z",
    };
    const text = disclosure.composeDisclosure("Note", facts);
    expect(text).toContain("1 agent turn on 2026-07-30");
    expect(text).not.toContain("Model(s)");
    expect(text).toMatch(/no direct file edits/);
  });
});
