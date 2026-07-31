/**
 * Tool-result visibility: the read-only resultHead summary — which tools get
 * one, the single-line/size-cap shaping, the Claude SDK content extraction,
 * and that the summary survives transcript persistence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-resulthead-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("resultHead", () => {
  it("summarizes read-only tool results and skips everything else", async () => {
    const { resultHead } = await import("../src/backends/types.js");
    expect(resultHead("Grep", "Found 12 matches")).toBe("Found 12 matches");
    expect(resultHead("Read", "\\documentclass{article}")).toBe("\\documentclass{article}");
    expect(resultHead("WebSearch", "one hit")).toBe("one hit");
    // The openai backend's directory listing gets the same treatment as Glob.
    expect(resultHead("list_files", "main.tex\nrefs.bib")).toBe("main.tex refs.bib (2 lines)");
    expect(resultHead("mcp__blattbot__search_papers", "1. A paper")).toBe("1. A paper");
    expect(resultHead("mcp__blattbot__list_citations", "\\cite{a} — T")).toBe("\\cite{a} — T");
    // Edit tools and unknown tools never leak result content.
    expect(resultHead("Edit", "secret file content")).toBeUndefined();
    expect(resultHead("Write", "secret")).toBeUndefined();
    expect(resultHead("Bash", "output")).toBeUndefined();
    expect(resultHead("mcp__blattbot__add_citation", "Added x")).toBeUndefined();
    expect(resultHead("", "text")).toBeUndefined();
  });

  it("collapses to a single line and appends the line count", async () => {
    const { resultHead } = await import("../src/backends/types.js");
    expect(resultHead("Grep", "main.tex:3\nintro.tex:9\n\nrefs.bib:1\n")).toBe(
      "main.tex:3 intro.tex:9 refs.bib:1 (3 lines)",
    );
    // Single-line results carry no count.
    expect(resultHead("Glob", "  main.tex  ")).toBe("main.tex");
  });

  it("caps the head at RESULT_HEAD_MAX characters", async () => {
    const { resultHead, RESULT_HEAD_MAX } = await import("../src/backends/types.js");
    const long = "x".repeat(RESULT_HEAD_MAX * 3);
    const head = resultHead("Read", long)!;
    expect(head.length).toBeLessThanOrEqual(RESULT_HEAD_MAX);
    expect(head.endsWith("…")).toBe(true);
    // Multi-line long results keep both the cap and the count.
    const longLines = Array.from({ length: 40 }, (_, i) => `line ${i} `.repeat(10)).join("\n");
    const multi = resultHead("Grep", longLines)!;
    expect(multi).toMatch(/… \(40 lines\)$/);
    expect(multi.length).toBeLessThanOrEqual(RESULT_HEAD_MAX + " (40 lines)".length);
  });

  it("returns undefined for empty or non-text results", async () => {
    const { resultHead } = await import("../src/backends/types.js");
    expect(resultHead("Grep", "")).toBeUndefined();
    expect(resultHead("Grep", "   \n  ")).toBeUndefined();
    expect(resultHead("Grep", undefined)).toBeUndefined();
    expect(resultHead("Grep", { weird: true })).toBeUndefined();
  });
});

describe("claude toolResultText", () => {
  it("reads plain strings and SDK content-block arrays", async () => {
    const { toolResultText } = await import("../src/backends/claude.js");
    expect(toolResultText("plain result")).toBe("plain result");
    expect(
      toolResultText([
        { type: "text", text: "first" },
        { type: "image", source: {} },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
    expect(toolResultText([{ type: "text", text: 42 }])).toBe("");
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText({ type: "text", text: "not an array" })).toBe("");
  });
});

describe("resultHead persistence", () => {
  it("round-trips through the chat transcript like fileDiff does", async () => {
    const chats = await import("../src/chats.js");
    const chat = chats.createChat("p1");
    chats.appendEvent("p1", chat.id, { type: "tool_use", id: "t1", name: "Grep", detail: "attention" });
    chats.appendEvent("p1", chat.id, {
      type: "tool_result",
      id: "t1",
      isError: false,
      resultHead: "main.tex:8 intro.tex:2 (2 lines)",
    });
    const events = chats.readTranscript("p1", chat.id);
    expect(events[1]).toEqual({
      type: "tool_result",
      id: "t1",
      isError: false,
      resultHead: "main.tex:8 intro.tex:2 (2 lines)",
    });
  });
});
