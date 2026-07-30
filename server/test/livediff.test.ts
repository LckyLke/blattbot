import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  TRUNCATION_MARKER,
  isEditTool,
  makeTurnEventSink,
  synthesizeUntrackedDiff,
  truncateDiff,
  type AgentEventLike,
} from "../src/livediff.js";
import { parseDiff } from "../../web/src/diff.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A platform-real absolute dir — a bare "/proj" never prefix-matches the
// drive-letter paths resolve() produces on Windows.
const PROJ = resolve("/proj");

function collectingSink(opts: Parameters<typeof makeTurnEventSink>[2] = {}) {
  const events: AgentEventLike[] = [];
  const calls = { workingDiff: 0, fileDiff: [] as string[] };
  const sink = makeTurnEventSink(PROJ, (e) => events.push(e), {
    debounceMs: 10,
    workingDiff: async () => {
      calls.workingDiff++;
      return "WORKING-DIFF";
    },
    fileDiff: async (_dir, rel) => {
      calls.fileDiff.push(rel);
      return `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n@@ -1 +1 @@\n-x\n+y\n`;
    },
    fileExists: () => true,
    ...opts,
  });
  return { events, calls, ...sink };
}

describe("edit-tool detection", () => {
  it("recognizes the SDK's file-editing tools by plain name", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(isEditTool(name)).toBe(true);
    }
    for (const name of ["Read", "Bash", "Grep", "mcp__blattbot__compile_latex", ""]) {
      expect(isEditTool(name)).toBe(false);
    }
  });
});

describe("truncateDiff", () => {
  it("leaves small diffs untouched", () => {
    expect(truncateDiff("short\n", 100)).toBe("short\n");
  });

  it("cuts on a line boundary and appends the marker", () => {
    const diff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n") + "\n";
    const out = truncateDiff(diff, 200);
    expect(Buffer.byteLength(out)).toBeLessThan(300);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    const beforeMarker = out.slice(0, -TRUNCATION_MARKER.length - 1);
    // Every kept line is intact — no mid-line cut.
    for (const line of beforeMarker.split("\n")) expect(line).toMatch(/^\+line \d+$/);
  });
});

describe("synthesizeUntrackedDiff", () => {
  it("builds a parseable all-added diff for a new text file", () => {
    const out = synthesizeUntrackedDiff("sections/new.tex", "alpha\nbeta\n");
    expect(out).toContain("diff --git a/sections/new.tex b/sections/new.tex");
    expect(out).toContain("new file mode 100644");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/sections/new.tex");
    expect(out).toContain("@@ -0,0 +1,2 @@");
    const files = parseDiff(out);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("added");
    expect(files[0].additions).toBe(2);
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual(["alpha", "beta"]);
  });

  it("marks a missing trailing newline", () => {
    const out = synthesizeUntrackedDiff("a.txt", "only line");
    expect(out).toContain("@@ -0,0 +1,1 @@");
    expect(out).toContain("+only line\n\\ No newline at end of file");
  });

  it("handles binary and empty files without fabricating hunks", () => {
    const bin = synthesizeUntrackedDiff("img.png", Buffer.from([0x89, 0x00, 0x50]));
    expect(bin).toContain("Binary files /dev/null and b/img.png differ");
    expect(parseDiff(bin)[0]?.hunks).toEqual([]);
    const empty = synthesizeUntrackedDiff("empty.txt", "");
    expect(empty).toContain("new file mode 100644");
    expect(empty).not.toContain("@@");
  });
});

describe("makeTurnEventSink", () => {
  const editUse = (id: string, detail: string, name = "Edit"): AgentEventLike => ({
    type: "tool_use",
    id,
    name,
    detail,
  });
  const result = (id: string, isError = false): AgentEventLike => ({ type: "tool_result", id, isError });

  it("passes unrelated events through untouched", async () => {
    const s = collectingSink();
    s.sink({ type: "text_delta", text: "hi" });
    s.sink(editUse("t1", "notes.md", "Read"));
    s.sink(result("t1"));
    await s.close();
    expect(s.events.map((e) => e.type)).toEqual(["text_delta", "tool_use", "tool_result"]);
    expect(s.calls.workingDiff).toBe(0);
    expect(s.calls.fileDiff).toEqual([]);
  });

  it("debounces edit results into one live diff broadcast", async () => {
    const s = collectingSink();
    s.sink(editUse("t1", "main.tex"));
    s.sink(result("t1"));
    s.sink(editUse("t2", "main.tex", "Write"));
    s.sink(result("t2"));
    await sleep(60);
    expect(s.calls.workingDiff).toBe(1);
    const live = s.events.filter((e) => e.type === "diff");
    expect(live).toEqual([{ type: "diff", diff: "WORKING-DIFF", live: true }]);
    await s.close();
  });

  it("enriches edit tool_results with the touched file's diff", async () => {
    const s = collectingSink();
    s.sink(editUse("t1", "sections/intro.tex"));
    s.sink(result("t1"));
    await s.close();
    const r = s.events.find((e) => e.type === "tool_result")!;
    expect(r.id).toBe("t1");
    expect(String(r.fileDiff)).toContain("diff --git a/sections/intro.tex b/sections/intro.tex");
    expect(s.calls.fileDiff).toEqual(["sections/intro.tex"]);
  });

  it("truncates oversized file diffs with a marker", async () => {
    const huge = "+x".repeat(60_000);
    const s = collectingSink({
      fileDiff: async () => `diff --git a/a b/a\n${huge}\n`,
      fileExists: () => true,
      debounceMs: 10,
      workingDiff: async () => "",
    });
    s.sink(editUse("t1", "a"));
    s.sink(result("t1"));
    await s.close();
    const r = s.events.find((e) => e.type === "tool_result")!;
    expect(Buffer.byteLength(String(r.fileDiff))).toBeLessThanOrEqual(41_000);
    expect(String(r.fileDiff).endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("skips enrichment for errored results, escaping paths, and missing files", async () => {
    const s = collectingSink();
    s.sink(editUse("t1", "main.tex"));
    s.sink(result("t1", true)); // errored → no enrichment
    s.sink(editUse("t2", "../outside.tex"));
    s.sink(result("t2")); // escapes the project → no enrichment
    await s.close();
    const results = s.events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.fileDiff).toBeUndefined();
    expect(s.calls.fileDiff).toEqual([]);

    const missing = collectingSink({ fileExists: () => false });
    missing.sink(editUse("t1", "gone.tex"));
    missing.sink(result("t1"));
    await missing.close();
    expect(missing.events.find((e) => e.type === "tool_result")!.fileDiff).toBeUndefined();
  });

  it("clears the pending live-diff timer on turn_end", async () => {
    const s = collectingSink();
    s.sink(editUse("t1", "main.tex"));
    s.sink(result("t1"));
    s.sink({ type: "turn_end" });
    await sleep(60);
    expect(s.calls.workingDiff).toBe(0);
    expect(s.events.filter((e) => e.type === "diff")).toEqual([]);
    await s.close();
  });

  it("never emits a live diff after close()", async () => {
    const s = collectingSink();
    s.sink(editUse("t1", "main.tex"));
    s.sink(result("t1"));
    await s.close();
    await sleep(60);
    expect(s.events.filter((e) => e.type === "diff")).toEqual([]);
  });
});
