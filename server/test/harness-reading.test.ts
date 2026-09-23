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
    const { executeTool } = await import("../src/backends/openai.js");
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
  it("pages oversized evidence reports with recoverable filters and a global strict policy", async () => {
    const body = Array.from({ length: 150 }, (_, i) => `Claim ${i}: ${"Scientific content ".repeat(70)}\\cite{${i % 2 ? "alpha" : "beta"}}.\n\n`).join("");
    writeFileSync(join(dir, "main.tex"), body);
    writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Alpha}}\n@article{beta,title={Beta}}");
    const { evidencePage, strictReportPage } = await import("../src/research/report-pages.js");
    const { saveResearchPolicy } = await import("../src/research/strict.js");
    saveResearchPolicy("p1", true);
    const ctx = { project: { id: "p1" }, dir, contextDirs: [], signal: new AbortController().signal, emit: vi.fn() } as any;
    const run = async (name: string, args = {}) => {
      const raw = JSON.stringify(name === "list_evidence" ? evidencePage("p1", dir, args) : strictReportPage("p1", dir, args));
      expect(raw.length).toBeLessThan(40000);
      const result = JSON.parse(raw); expect(result.error).toBeUndefined(); return result;
    };
    const first = await run("list_evidence", { limit: 100 });
    expect(first.summary.totalClaims).toBeGreaterThan(100);
    expect(first.nextOffset).toBeGreaterThan(0);
    const second = await run("list_evidence", { offset: first.nextOffset, limit: 100 });
    expect(first.items.map((x: any) => x.id)).not.toContain(second.items[0].id);
    const filtered = await run("list_evidence", { key: "alpha", status: "unchecked", limit: 2 });
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((x: any) => x.key === "alpha" && x.status === "unchecked")).toBe(true);
    const strict = await run("strict_evidence_report", { limit: 100 });
    expect(strict).toMatchObject({ strict: true, policy: { strict: true }, ready: false });
    expect(strict.nextOffset).toBeGreaterThan(0);
    const empty = await run("strict_evidence_report", { key: "missing" });
    expect(empty).toMatchObject({ issues: [], nextOffset: null, strict: true, ready: false, open: strict.open });
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
