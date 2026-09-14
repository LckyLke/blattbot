import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
import type { BackendTurnContext, AgentEvent } from "../src/backends/types.js";

let root: string;
let dir: string;
let uploads: string;
let ctx: BackendTurnContext;
let events: AgentEvent[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-reading-"));
  dir = join(root, "project");
  uploads = join(root, "context", "p1");
  mkdirSync(dir);
  mkdirSync(uploads, { recursive: true });
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
  writeFileSync(join(dir, "refs.bib"), "@article{smith2020, title={Graph Models}, year={2020}}\n");
  events = [];
  ctx = { project: { id: "p1", name: "Test", gitUrl: "local", createdAt: "" }, dir, contextDirs: [uploads], readOnly: false,
    prompt: "", systemAppend: "", model: "", attachments: [], session: {}, settings: {} as BackendTurnContext["settings"],
    signal: new AbortController().signal, emit: (event: AgentEvent) => { events.push(event); }, paperReads: new Set() };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("direct paper reading", () => {
  it.each([
    ["Towards Foundation Models for Knowledge Graph Reasoning", "T OWARDS F OUNDATION M ODELS FOR K NOWLEDGE G RAPH R EASONING"],
    ["InGram: Inductive Knowledge Graph Embedding via Relation Graphs", "I N G RAM: Inductive Knowledge Graph Embedding via Relation Graphs"],
    ["An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale", "A N I MAGE IS W ORTH 16 X 16 W ORDS: T RANSFORMERS FOR I MAGE R ECOGNITION AT S CALE"],
  ])("recognizes the complete title despite small-cap PDF spacing: %s", async (title, heading) => {
    writeFileSync(join(dir, "refs.bib"), `@article{smith2020, title={${title}}, year={2020}}`);
    writeFileSync(join(uploads, "smith2020.pdf"), textPdf([`${heading}\nAbstract\nActual paper contents.`]));
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "smith2020")).toMatchObject({ basis: "full_text" });
  });

  it("does not use small-cap title mentions in the abstract as paper identity", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{smith2020, title={Towards Foundation Models for Knowledge Graph Reasoning}, year={2020}}");
    writeFileSync(join(uploads, "smith2020.pdf"), textPdf(["A Different Paper. Abstract. We review T OWARDS F OUNDATION M ODELS FOR K NOWLEDGE G RAPH R EASONING."]));
    const { readPaper } = await import("../src/papers.js");
    expect(await readPaper("p1", dir, "smith2020")).toMatchObject({ basis: "none" });
  });
  it("opens an attached PDF, searches later pages, and reuses the binding for verification", async () => {
    const path = join(uploads, "author-manuscript.pdf");
    writeFileSync(path, textPdf(["Graph Models. Introduction.", "Ablation accuracy was 91 percent."]));
    const { readPaper, verifyCitationSupport } = await import("../src/papers.js");
    const result = await readPaper("p1", dir, "smith2020", { path, query: "ablation" });
    expect(result.basis).toBe("full_text");
    expect(result.excerpt?.text).toContain("Page 2");
    expect(result.excerpt?.text).toContain("91 percent");
    expect(result.excerpt?.complete).toBe(false);
    const judge = vi.fn(async (_prompt: string) => "SUPPORTED\nThe ablation result states 91 percent.");
    const check = await verifyCitationSupport("p1", dir, "smith2020", "Ablation accuracy was 91 percent.", { judge });
    expect(check.verdict).toBe("supported");
    expect(judge.mock.calls[0]?.[0]).toContain("[Page 2]");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finds an uploaded exact-key PDF and returns real text through the Codex/OpenAI tools", async () => {
    writeFileSync(join(uploads, "smith2020.pdf"), textPdf(["Graph Models. An actual source statement."]));
    const { executeTool, toolDefinitions } = await import("../src/backends/openai.js");
    const result = await executeTool(ctx, "read_paper", { key: "smith2020" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("An actual source statement");
    expect(ctx.paperReads?.has("smith2020")).toBe(true);
    expect(toolDefinitions(true).some((tool) => tool.function.name === "read_paper")).toBe(true);
    expect(events).toEqual([]);
  });

  it("lets read_file extract uploaded PDFs and paginate instead of returning binary bytes", async () => {
    const path = join(uploads, "context.pdf");
    writeFileSync(path, textPdf(["a ".repeat(300), "This is the final result."]));
    const { executeTool } = await import("../src/backends/openai.js");
    const first = await executeTool(ctx, "read_file", { path, limit: 100 });
    expect(first.content).toContain("Continue with offset=100");
    const next = await executeTool(ctx, "read_file", { path, offset: 100, limit: 4000 });
    expect(next.content).toContain("This is the final result");
    expect(next.content).toContain("[Page 2]");
    expect(next.content).not.toContain("All extracted text returned");
  });

  it("reports absent sources directly to the chat and never marks them as abstract/read", async () => {
    const { executeTool } = await import("../src/backends/openai.js");
    const result = await executeTool(ctx, "read_paper", { key: "smith2020" });
    expect(result.content).toContain("Content: NONE");
    expect(result.content).toContain("External context");
    expect(events.some((event) => event.type === "notice" && String(event.text).includes("smith2020"))).toBe(true);
    expect(ctx.paperReads?.size).toBe(0);
    const { verifyCitationSupport } = await import("../src/papers.js");
    const judge = vi.fn();
    expect(await verifyCitationSupport("p1", dir, "smith2020", "A claim", { judge })).toMatchObject({ basis: "none", verdict: "unclear" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("labels abstract-only evidence and emits a warning without relying on the model", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{smith2020, title={Graph Models}, abstract={We study graphs.}}");
    const { executeTool } = await import("../src/backends/openai.js");
    const result = await executeTool(ctx, "read_paper", { key: "smith2020" });
    expect(result.content).toContain("Content: ABSTRACT");
    expect(result.content).toContain("We study graphs");
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", text: expect.stringContaining("Only the abstract") }));
  });

  it("does not treat summaries or a zero-hit search as having read evidence", async () => {
    const { writePaperRecord } = await import("../src/papers.js");
    writePaperRecord("p1", "smith2020", { summary: "A tempting generated summary", source: "agent" });
    const { executeTool } = await import("../src/backends/openai.js");
    expect((await executeTool(ctx, "read_paper", { key: "smith2020" })).content).not.toContain("A tempting generated summary");
    writeFileSync(join(uploads, "smith2020.pdf"), textPdf(["Graph Models. Contents."]));
    const result = await executeTool(ctx, "read_paper", { key: "smith2020", query: "nonexistent" });
    expect(result.content).toContain("No exact text matches");
    expect(ctx.paperReads?.size).toBe(0);
  });

  it("does not associate a different or scanned paper just because the filename matches", async () => {
    const path = join(uploads, "smith2020.pdf");
    const { readPaper } = await import("../src/papers.js");
    writeFileSync(path, textPdf(["An unrelated article"]));
    expect(await readPaper("p1", dir, "smith2020")).toMatchObject({ basis: "none", limitations: [expect.stringContaining("could not be matched")] });
    writeFileSync(path, textPdf([""]));
    expect(await readPaper("p1", dir, "smith2020")).toMatchObject({ basis: "none", limitations: [expect.stringContaining("OCR/text version")] });
  });

  it("re-extracts changed PDFs and rejects a binding after its context was detached", async () => {
    const path = join(uploads, "manuscript.pdf");
    const { readPaper } = await import("../src/papers.js");
    writeFileSync(path, textPdf(["Graph Models. Original result."]));
    await readPaper("p1", dir, "smith2020", { path });
    writeFileSync(path, textPdf(["Graph Models. Corrected result."]));
    const changed = await readPaper("p1", dir, "smith2020");
    expect(changed.excerpt?.text).toContain("Corrected result");
    expect(changed.excerpt?.text).not.toContain("Original result");
    const detached = await readPaper("p1", dir, "smith2020", { contextDirs: [] });
    expect(detached.basis).toBe("none");
    expect(detached.limitations.join()).toContain("outside the project");
  });

  it("rejects outside paths, traversal, and symlink escapes", async () => {
    const outside = join(root, "outside.pdf");
    writeFileSync(outside, textPdf(["Graph Models. Secret text."]));
    symlinkSync(outside, join(uploads, "escape.pdf"));
    const { readPaper } = await import("../src/papers.js");
    for (const path of [outside, "../outside.pdf", join(uploads, "escape.pdf")]) {
      const result = await readPaper("p1", dir, "smith2020", { path });
      expect(result.basis).toBe("none");
      expect(result.excerpt).toBeUndefined();
    }
  });

  it("rejects invalid offsets and unknown bibliography keys", async () => {
    writeFileSync(join(uploads, "smith2020.pdf"), textPdf(["Graph Models"]));
    const { executeTool } = await import("../src/backends/openai.js");
    for (const args of [{ key: "missing" }, { key: "smith2020", offset: -1 }, { key: "smith2020", limit: 50000 }]) {
      expect((await executeTool(ctx, "read_paper", args)).isError).toBe(true);
    }
  });
});

describe("long source text", () => {
  it("verifies results after character 60000 and labels the selected excerpts", async () => {
    const path = join(uploads, "smith2020.pdf");
    writeFileSync(path, textPdf(["Graph Models", ...Array.from({ length: 30 }, () => "General background discussion. ".repeat(95)), "Ablation accuracy was 91 percent."]));
    const { extractPdfPages } = await import("../src/pdftext.js");
    expect((await extractPdfPages(path)).join().length).toBeGreaterThan(60_000);
    const { verifyCitationSupport, formatCitationCheckResult } = await import("../src/papers.js");
    const judge = vi.fn(async (_prompt: string) => "SUPPORTED\nThe ablation result explicitly states this.");
    const result = await verifyCitationSupport("p1", dir, "smith2020", "Ablation accuracy was 91 percent.", { judge });
    expect(result).toMatchObject({ basis: "full_text", truncated: true });
    expect(judge.mock.calls[0][0]).toContain("Ablation accuracy was 91 percent.");
    expect(judge.mock.calls[0][0]).toContain("selected excerpts");
    expect(formatCitationCheckResult("smith2020", "Ablation accuracy was 91 percent.", result)).toContain("selected PDF excerpts only");
  });

  it("can read and search beyond 60000 characters with usable offsets", async () => {
    const { readTextPages } = await import("../src/pdftext.js");
    const pages = ["Intro ".repeat(12000), "Ablation accuracy is 91 percent."];
    const match = readTextPages(pages, { query: "ablation" });
    expect(match.text).toContain("Page 2");
    expect(match.text).toContain("91 percent");
    const late = readTextPages(pages, { offset: 72000 });
    expect(late.text).toContain("91 percent");
    expect(late.complete).toBe(false);
    const repeated = readTextPages(["needle ".repeat(100)], { query: "needle" });
    expect(repeated.nextOffset).toBeGreaterThan(0);
  });
});
