import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("strict scientific writing", () => {
  it("keeps unknown evidence and uncited assertions open, and blocks approval only when enabled", async () => {
    const s = await import("../src/research/strict.js");
    expect(s.strictReport(id, dir).strict).toBe(false);
    expect(() => s.assertStrictReady(id, dir)).not.toThrow();
    s.saveResearchPolicy(id, true);
    const report = s.strictReport(id, dir);
    expect(report.issues.some(i => i.key === "alpha")).toBe(true);
    expect(report.issues.some(i => !i.key && i.text.includes("every dataset"))).toBe(true);
    expect(() => s.assertStrictReady(id, dir)).toThrow("passages still need evidence");
  });
  it("requires quoted claim evidence, records human exceptions, and invalidates edited passages", async () => {
    const e = await import("../src/research/evidence.js"); const s = await import("../src/research/strict.js");
    s.saveResearchPolicy(id, true);
    await e.verifyClaim(id, dir, e.manuscriptClaims(dir)[0].id, async () => JSON.stringify({ verdict: "supported", explanation: "Same result", quotes: [{ page: 2, quote: "The method reaches 91 percent accuracy on dataset A." }] }));
    expect(s.strictReport(id, dir).issues.some(i => i.key)).toBe(false);
    await s.auditUncitedClaims(id, dir, async prompt => {
      const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      return JSON.stringify(batch.map((p: any) => ({ id: p.id, classification: "needs_evidence", reason: "Unqualified generalization" })));
    });
    const issue = s.strictReport(id, dir).issues[0];
    expect(() => s.decideClaim(id, dir, { ...issue, reason: "ok", accept: true })).toThrow();
    s.decideClaim(id, dir, { ...issue, reason: "Reviewed against all documented experiments in results.csv.", accept: true });
    expect(s.strictReport(id, dir).ready).toBe(true);
    writeFileSync(join(dir, "main.tex"), readFileSync(join(dir, "main.tex"), "utf8").replace("every training budget", "every possible architecture"));
    expect(s.strictReport(id, dir).ready).toBe(false);
    expect(() => s.decideClaim(id, dir, { ...issue, reason: "Old approval must fail", accept: true })).toThrow("changed");
  });
  it("does not treat a partial or omitted classifier response as clearance", async () => {
    const s = await import("../src/research/strict.js");
    await s.auditUncitedClaims(id, dir, async () => "[]");
    const issue = s.strictReport(id, dir).issues.find(i => !i.key)!;
    expect(issue.reason).toContain("uncertain");
  });
  it("finds decimal numbers and preserves source line locations", async () => {
    const s = await import("../src/research/strict.js");
    writeFileSync(join(dir, "main.tex"), "\\section{Results}\n\nOur method achieves 91.5 percent accuracy on the previously unseen benchmark.\n");
    const issue = s.strictReport(id, dir).issues[0];
    expect(issue.text).toContain("91.5"); expect(issue.line).toBe(3);
    writeFileSync(join(dir, "main.tex"), "\\caption{Accuracy is 99\\%.}\n\nAccuracy is 99\\%.");
    expect(s.strictReport(id, dir).issues).toHaveLength(2);
  });
});

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

describe("scientific evaluation", () => {
  it("runs the actual quote-validation pipeline without leaking expected labels", async () => {
    const e = await import("../src/research/evaluation.js");
    const c = e.evaluationCases(id)[0];
    const call = vi.fn(async (_prompt: string) => JSON.stringify({ verdict: "supported", explanation: "Proposed answer", quotes: [{ page: 1, quote: "A fabricated measurement not in the source" }] }));
    const result = await e.evaluateCase(id, c.id, call);
    expect(result.verdict).toBe("unclear");
    expect(call.mock.calls[0][0]).not.toContain(c.rationale);
    expect(e.evaluationReport(id).groups[0].accuracy).toBeNull();
    expect(e.evaluationReport(id).reviewed).toBe(0);
  });
  it("scores only version-matched human judgments and reports false support", async () => {
    const e = await import("../src/research/evaluation.js");
    const c = e.evaluationReport(id).cases.find(c => c.category === "wrong-number")!;
    e.reviewEvaluationCase(id, { id: c.id, hash: c.hash, expected: "not_supported", reason: "I checked the numeric value against the linked abstract." });
    await e.evaluateCase(id, c.id, async () => JSON.stringify({ verdict: "supported", explanation: "A deliberately wrong judgment", quotes: [{ page: 1, quote: c.excerpt }] }));
    expect(e.evaluationReport(id).groups[0]).toMatchObject({ reviewed: 1, accuracy: 0, falseSupportRate: 1 });
    e.importEvaluationCases(id, [{ ...c, claim: "A changed evaluation claim requiring another review." }]);
    expect(e.evaluationReport(id).reviewed).toBe(0); expect(e.evaluationReport(id).groups).toEqual([]);
  });
});
