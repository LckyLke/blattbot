import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
let root: string, dir: string, id: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-reliability-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  const cfg = await import("../src/config.js");
  id = cfg.addProject({ name: "Reliability", kind: "local", gitUrl: "" }).id;
  dir = cfg.projectDir(id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Graph Models},author={Ada},year={2020}}\n@article{beta,title={Neural Networks},author={Bea},year={2021}}");
  writeFileSync(join(dir, "main.tex"), "The method reaches 91 percent accuracy on dataset A~\\cite{alpha}.\n\nThese results are valid for every dataset and every training budget.");
  writeFileSync(join(dir, "alpha.pdf"), textPdf(["Graph Models. Introduction.", "The method reaches 91 percent accuracy on dataset A.", "The graph model fails on dataset B; no improvement was observed."]));
  writeFileSync(join(dir, "beta.pdf"), textPdf(["Neural Networks. Introduction.", "The neural model improves prediction on dataset B."]));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe("persistent paper-library index", () => {
  it("rejects bibliography changes during source reading before persisting an index", async () => {
    const papers = await import("../src/papers.js");
    const lib = await import("../src/research/library.js");
    const read = vi.spyOn(papers, "getPaperContent").mockImplementationOnce(async () => {
      writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={A different paper}}");
      return { key: "alpha", title: "Graph Models", basis: "abstract", pages: ["The old source's evidence."], limitations: [] };
    });
    try {
      await expect(lib.indexPaper(id, dir, "alpha")).rejects.toThrow("Bibliography changed");
      expect(lib.libraryStatus(id, dir).indexed).toBe(0);
    } finally { read.mockRestore(); }
  });
  it("retrieves original page passages across papers, including evidence beyond the first pages", async () => {
    const lib = await import("../src/research/library.js");
    await lib.indexPaper(id, dir, "alpha"); await lib.indexPaper(id, dir, "beta");
    const result = await lib.searchLibrary(id, dir, { query: "dataset B", limit: 1 });
    expect(result.total).toBeGreaterThan(1); expect(result.nextOffset).toBe(1);
    const all = await lib.searchLibrary(id, dir, { query: "dataset B" });
    expect(new Set(all.results.map(r => r.key))).toEqual(new Set(["alpha", "beta"]));
    expect(all.results.find(r => r.key === "alpha")?.page).toBe(3);
    expect(all.results.find(r => r.key === "alpha")?.quote).toContain("fails");
    vi.resetModules(); const reopened = await import("../src/research/library.js");
    expect((await reopened.searchLibrary(id, dir, { query: "observed" })).results[0].page).toBe(3);
    expect((await reopened.searchLibrary(id, dir, { query: "constructor" })).total).toBe(0);
  });
  it("excludes edited sources, deleted bibliography entries, and exposes coverage gaps", async () => {
    const lib = await import("../src/research/library.js");
    await lib.indexPaper(id, dir, "alpha"); await lib.indexPaper(id, dir, "beta");
    writeFileSync(join(dir, "alpha.pdf"), textPdf(["Graph Models. Changed evidence."]));
    const result = await lib.searchLibrary(id, dir, { query: "dataset" });
    expect(result.results.every(r => r.key !== "alpha")).toBe(true);
    expect(result.coverage.sources.find(s => s.key === "alpha")?.status).toBe("stale");
    writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Graph Models},year={2020}}");
    expect((await lib.searchLibrary(id, dir, { query: "prediction" })).results).toEqual([]);
  });
  it("prioritizes paper content, hides bibliography hits by default and retains appendices", async () => {
    writeFileSync(join(dir, "alpha.pdf"), textPdf(["Graph Models\nThe graph model generalizes poorly.\nReferences\n[1] Famous benchmark model generalizes perfectly.", "[2] Another benchmark model citation.\nAppendix A\nThe benchmark model ablation uses five seeds."]));
    const lib = await import("../src/research/library.js");
    await lib.indexPaper(id, dir, "alpha");
    const result = await lib.searchLibrary(id, dir, { query: "benchmark model" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ page: 2, section: "appendix" });
    expect(result.results[0].quote).toContain("five seeds");
    expect(result.excludedReferences).toBeGreaterThan(0);
    const references = await lib.searchLibrary(id, dir, { query: "benchmark model", includeReferences: true });
    expect(references.results.some(r => r.section === "references")).toBe(true);
    expect(references.results[0].section).toBe("appendix");
  });
  it("requires meaningful terms or an exact phrase and offers an explicit broader search", async () => {
    const lib = await import("../src/research/library.js");
    await lib.indexPaper(id, dir, "alpha");
    expect((await lib.searchLibrary(id, dir, { query: "accuracy nonexistent" })).total).toBe(0);
    expect((await lib.searchLibrary(id, dir, { query: "accuracy nonexistent", match: "any" })).total).toBeGreaterThan(0);
    expect((await lib.searchLibrary(id, dir, { query: "91 percent accuracy", match: "phrase" })).results[0].page).toBe(2);
    expect((await lib.searchLibrary(id, dir, { query: "accuracy 91 percent", match: "phrase" })).total).toBe(0);
  });
  it("expands semantic terms but returns only actual source passages", async () => {
    const lib = await import("../src/research/library.js"); await lib.indexPaper(id, dir, "beta");
    const result = await lib.searchLibrary(id, dir, { query: "Vorhersage", semantic: true }, async () => '["prediction"]');
    expect(result.results[0].quote).toContain("prediction"); expect(result.expanded).toEqual(["prediction"]);
  });
});
