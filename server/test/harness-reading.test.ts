import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let root: string, dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-reading-")); dir = join(root, "project"); mkdirSync(dir);
  vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("recoverable harness reads", () => {
  it("slices a 71,799-character manuscript through read_file and returns continuation metadata", async () => {
    const content = "A".repeat(120) + "B".repeat(120) + "C".repeat(71559);
    writeFileSync(join(dir, "main.tex"), content);
    const { executeTool } = await import("../src/backends/tools.js");
    const ctx = { project: { id: "p1" }, dir, contextDirs: [], signal: new AbortController().signal, emit: vi.fn() } as any;
    const first = await executeTool(ctx, "read_file", { path: "main.tex", offset: 0, limit: 120 });
    const second = await executeTool(ctx, "read_file", { path: "main.tex", offset: 120, limit: 120 });
    expect(JSON.stringify(first)).toContain("A".repeat(120));
    expect(JSON.stringify(first)).not.toContain("BBBB");
    expect(JSON.stringify(second)).toContain("B".repeat(120));
    expect(JSON.stringify(second)).toContain("offset=240");
    expect(JSON.stringify(first)).toContain("71799");
    expect(JSON.stringify(first).length).toBeLessThan(1000);
    expect(readFileSync(join(dir, "main.tex"), "utf8")).toBe(content);
  });
  it("merges nearby search hits and normalizes whitespace while keeping original offsets", async () => {
    const { readTextDocument, readTextPages } = await import("../src/pdftext.js");
    const document = "Graph\n  models work. Graph models also work. " + "x".repeat(1400) + "Graph\tmodels finish.";
    const first = readTextDocument(document, { query: "graph models", limit: 300 });
    expect(first.text).toContain("Graph\n  models");
    expect(first.text.match(/offset \d+:/g)).toHaveLength(1);
    expect(first.nextOffset).toBeGreaterThan(0);
    const next = readTextDocument(document, { query: "graph models", offset: first.nextOffset, limit: 300 });
    expect(next.text).toContain("Graph\tmodels finish.");
    expect(next.text).not.toContain("also work");
    expect(next.nextOffset).toBeUndefined();
    expect(readTextPages(["First", "Graph\nmodels"], { query: "graph models" }).text).toContain("Page 2");
    expect(readTextDocument("a+b (test)", { query: "a+b (test)" }).hasText).toBe(true);
  });
});
