import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
import { appendChatItem } from "../../web/src/citation-notices.js";
const judge = vi.hoisted(() => vi.fn());
vi.mock("../src/agent.js", () => ({ runOneShot: judge }));
let root: string, dir: string, pdf: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "citation-batches-")); dir = join(root, "project"); mkdirSync(dir);
  const uploads = join(root, "context", "p1"); mkdirSync(uploads, { recursive: true }); pdf = join(uploads, "alpha.pdf");
  writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Graph Models},year={2020}}");
  writeFileSync(pdf, textPdf(["Graph Models. Method A uses graphs. Accuracy is 91 percent."]));
  vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules(); judge.mockReset();
  judge.mockResolvedValue(JSON.stringify([{ id: 1, verdict: "PARTIALLY_SUPPORTED", explanation: "Only on dataset A." }, { id: 0, verdict: "SUPPORTED", explanation: "The method uses graphs." }]));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("batched citation support", () => {
  it("checks distinct claims in one request, restores order and reuses persisted results", async () => {
    const { verifyCitationSupportBatch: check } = await import("../src/papers.js");
    const result = await check("p1", dir, "alpha", ["Method A uses graphs.", "Accuracy is always 91 percent.", "Method A uses graphs."]);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.map(r => r.verdict)).toEqual(["supported", "partially_supported", "supported"]);
    vi.resetModules();
    const reloaded = await import("../src/papers.js");
    expect(await reloaded.verifyCitationSupport("p1", dir, "alpha", "Method A uses graphs.")).toEqual(result[0]);
    expect(judge).toHaveBeenCalledTimes(1);
    judge.mockResolvedValue("UNCLEAR\nThe supplied text does not state this.");
    await reloaded.verifyCitationSupport("p1", dir, "alpha", "Method B uses trees.");
    expect(judge).toHaveBeenCalledTimes(2);
    writeFileSync(pdf, textPdf(["Graph Models. Revised results: Method A now uses trees. Accuracy is 72 percent."]));
    await reloaded.verifyCitationSupport("p1", dir, "alpha", "Method A uses graphs.");
    expect(judge).toHaveBeenCalledTimes(3);
  });
  it("shares in-flight checks for overlapping requests", async () => {
    judge.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return "SUPPORTED\nUses graphs."; });
    const { verifyCitationSupport: check } = await import("../src/papers.js");
    await Promise.all([check("p1", dir, "alpha", "Uses graphs"), check("p1", dir, "alpha", "Uses graphs")]);
    expect(judge).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete batches without caching invented verdicts", async () => {
    judge.mockResolvedValue('[{"id":0,"verdict":"SUPPORTED","explanation":"A"}]');
    const { verifyCitationSupportBatch: check } = await import("../src/papers.js");
    await expect(check("p1", dir, "alpha", ["A", "B"])).rejects.toThrow(/incomplete/);
    await expect(check("p1", dir, "alpha", ["A", "B"])).rejects.toThrow(/incomplete/);
    expect(judge).toHaveBeenCalledTimes(2);
  });
  it("keeps coverage limits neutral and sends only problematic claims as expandable details", async () => {
    const { verifyPaperTool } = await import("../src/backends/paper-tools.js");
    const { readPaper } = await import("../src/papers.js");
    await readPaper("p1", dir, "alpha");
    const emit = vi.fn();
    const ctx = { project: { id: "p1" }, dir, contextDirs: [join(root, "context", "p1")], emit } as any;
    await verifyPaperTool(ctx, "alpha", ["Uses graphs", "Always 91 percent"]);
    const event = emit.mock.calls[0][0];
    expect(event).toMatchObject({ citationGroup: "alpha", tone: "warn" });
    expect(event.text).toContain("1/2 claims supported");
    expect(event.details).toContain("Always 91 percent");
    expect(event.details).not.toContain("Uses graphs");
    judge.mockResolvedValue("SUPPORTED\nConfirmed.");
    await verifyPaperTool(ctx, "alpha", "Always 91 percent, on dataset A");
    expect(emit.mock.calls[1][0].text).toContain("2/3 claims supported");
  });
  it("coalesces updates in one turn, preserving earlier turns and unrelated notices", () => {
    const first = { kind: "notice", citationGroup: "alpha", text: "1 checked" };
    const next = { ...first, text: "2 checked" };
    expect(appendChatItem([first], next)).toEqual([next]);
    expect(appendChatItem([first, { kind: "turn_end" }], next)).toEqual([first, { kind: "turn_end" }, next]);
    expect(appendChatItem([first, { kind: "notice", text: "Other" }], next)).toEqual([next, { kind: "notice", text: "Other" }]);
  });
});
