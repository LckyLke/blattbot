import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchJobs } from "../src/research/jobs.js";
import { textPdf } from "./fixtures/pdf.js";
let root: string, dir: string, id: string;
let workers: ResearchJobs[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "blattbot-jobs-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root); vi.resetModules(); workers = [];
  const cfg = await import("../src/config.js"); id = cfg.addProject({ name: "Jobs", kind: "local", gitUrl: "" }).id;
  dir = cfg.projectDir(id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Paper Alpha}}\n@article{beta,title={Paper Beta}}\n@article{gamma,title={Paper Gamma}}");
});
afterEach(async () => { await Promise.all(workers.map(w => w.stop())); vi.doUnmock("../src/research/library.js"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function make(run: ConstructorParameters<typeof ResearchJobs>[0]) { const { ResearchJobs } = await import("../src/research/jobs.js"); const worker = new ResearchJobs(run); workers.push(worker); return worker; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
/** The stub runners index nothing, so the library would report every source as still pending. */
const indexedLibrary = () => vi.doMock("../src/research/library.js", async (original) => ({ ...await original<object>(), libraryStatus: () => ({ pending: [] }) }));
describe("durable Research tasks", () => {
  it("automatically indexes existing sources and new bibliography additions", async () => {
    writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Paper Alpha}}");
    writeFileSync(join(dir, "alpha.pdf"), textPdf(["Paper Alpha. Graphs connect entities."]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const worker = await make(undefined);
    worker.start();
    await worker.idle();
    const { libraryStatus } = await import("../src/research/library.js");
    expect(libraryStatus(id, dir).indexed).toBe(1);
    writeFileSync(join(dir, "refs.bib"), "@article{alpha,title={Paper Alpha}}\n@article{beta,title={Paper Beta}}");
    writeFileSync(join(dir, "beta.pdf"), textPdf(["Paper Beta. Additional source."]));
    worker.scanLibraries(); await worker.idle();
    expect(libraryStatus(id, dir).indexed).toBe(2);
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id).every(j => j.automatic && j.state === "completed")).toBe(true);
  });
  it("waits for provider retry time before continuing and automatically retries failed sources", async () => {
    let clock = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const run = vi.fn(async (_id, _dir, _kind, key) => {
      if (run.mock.calls.length === 1) throw Object.assign(new Error("HTTP 429 rate limited"), { retryAt: clock + 120000 });
    });
    try {
      const worker = await make(run); worker.start(); await worker.idle();
      expect(run).toHaveBeenCalledTimes(1);
      const { listResearchJobs } = await import("../src/research/jobs.js");
      expect(listResearchJobs(id)[0].items[0]).toMatchObject({ state: "error", rateLimited: true, retryAt: clock + 120000 });
      clock += 119000; worker.scanLibraries(); await worker.idle();
      expect(run).toHaveBeenCalledTimes(1);
      clock += 1000; worker.scanLibraries(); await worker.idle();
      expect(run).toHaveBeenCalledTimes(3);
      worker.scanLibraries(); await worker.idle();
      expect(run.mock.calls.filter(c => c[3] === "alpha")).toHaveLength(2);
    } finally { time.mockRestore(); }
  });
  it("preserves provider cooldown and restarts automatic work after a server restart", async () => {
    let clock = Date.now();
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const first = await make(async () => { throw Object.assign(new Error("HTTP 429"), { retryAt: clock + 120000 }); });
      first.start(); await first.idle(); await first.stop();
      const run = vi.fn(async () => {});
      const second = await make(run); second.start(); await second.idle();
      expect(run).not.toHaveBeenCalled();
      await second.stop();
      const third = await make(run); third.start(); await third.idle();
      expect(run).not.toHaveBeenCalled();
      clock += 120000; third.scanLibraries(); await third.idle();
      expect(run).toHaveBeenCalledTimes(3);
    } finally { time.mockRestore(); }
  });
  it("deduplicates active requests, checkpoints each source and retries only failed items", async () => {
    indexedLibrary();
    const run = vi.fn(async (_id, _dir, _kind, key) => { if (key === "beta") throw new Error("Missing PDF"); });
    const worker = await make(run); const { listResearchJobs } = await import("../src/research/jobs.js");
    const job = worker.create(id, { kind: "library-index", keys: ["alpha", "beta", "gamma"] });
    expect(worker.create(id, { kind: "library-index", keys: ["alpha", "beta", "gamma"] }).id).toBe(job.id);
    await worker.idle();
    expect(listResearchJobs(id)[0]).toMatchObject({ state: "failed", items: [{ key: "alpha", state: "done" }, { key: "beta", state: "error", error: "Missing PDF" }, { key: "gamma", state: "done" }] });
    run.mockImplementation(async () => {});
    worker.control(id, job.id, "resume"); await worker.idle();
    expect(run.mock.calls.map(c => c[3])).toEqual(["alpha", "beta", "gamma", "beta"]);
    expect(listResearchJobs(id)[0].state).toBe("completed");
  });
  it("cancels the in-flight model context and rejects late artifact writes", async () => {
    const { researchSignal, saveStore, readStore } = await import("../src/research/store.js");
    let release!: () => void; let observed: AbortSignal | undefined;
    const run = vi.fn(async () => { observed = researchSignal(); await new Promise<void>(r => { release = r; }); saveStore(id, "test-result", { late: true }); });
    const worker = await make(run); const job = worker.create(id, { kind: "library-index", keys: ["alpha", "beta"] });
    await tick(); worker.control(id, job.id, "cancel");
    expect(observed?.aborted).toBe(true);
    release(); await worker.idle();
    expect(readStore(id, "test-result", null)).toBeNull(); expect(run).toHaveBeenCalledTimes(1);
    const { listResearchJobs } = await import("../src/research/jobs.js"); expect(listResearchJobs(id)[0].state).toBe("cancelled");
  });
  it("retains progress over a server restart and resumes pending items on request", async () => {
    indexedLibrary();
    const { saveStore } = await import("../src/research/store.js");
    saveStore(id, "jobs", [{ id: "interrupted", kind: "library-index", state: "running", createdAt: "before", updatedAt: "before", context: [], currentKey: "beta", items: [{ key: "alpha", state: "done" }, { key: "beta", state: "pending" }] }]);
    const run = vi.fn(async (_id: string, _dir: string, _kind: string, _key: string) => {}); const worker = await make(run); worker.start(false);
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id)[0].state).toBe("paused"); expect(listResearchJobs(id)[0].currentKey).toBeUndefined(); expect(run).not.toHaveBeenCalled();
    worker.control(id, "interrupted", "resume"); await worker.idle();
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][3]).toBe("beta");
    expect(listResearchJobs(id)[0].state).toBe("completed");
  });
  it("isolates projects and rejects unknown source keys before enqueuing", async () => {
    const worker = await make(async () => {});
    expect(() => worker.create(id, { kind: "library-index", keys: ["ghost"] })).toThrow("Unknown citation");
    const job = worker.create(id, { kind: "library-index", keys: ["alpha"] });
    expect(() => worker.control("another", job.id, "cancel")).toThrow("Unknown research job");
    await worker.idle();
  });
  it("pauses on shutdown and preserves completed results", async () => {
    const { researchSignal } = await import("../src/research/store.js");
    const worker = await make(async () => new Promise((_resolve, reject) => { researchSignal()!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }));
    worker.create(id, { kind: "library-index", keys: ["alpha", "beta"] }); await tick(); await worker.stop();
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id)[0].state).toBe("paused");
    expect(() => worker.create(id, { kind: "library-index", keys: ["gamma"] })).toThrow("shutting down");
  });
  it("keeps saved tasks of retired kinds on disk and never runs them", async () => {
    const { saveStore, readStore } = await import("../src/research/store.js");
    const base = { createdAt: "before", updatedAt: "before", context: [] };
    const evidence = { ...base, id: "old-evidence", kind: "evidence", state: "running", currentKey: "c1", items: [{ key: "c1", state: "pending" }] };
    const matrix = { ...base, id: "old-matrix", kind: "matrix", state: "completed", items: [{ key: "alpha", state: "done" }] };
    const review = { ...base, id: "old-review", kind: "review", state: "queued", items: [{ key: "manuscript", state: "pending" }] };
    saveStore(id, "jobs", [evidence, matrix, review]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => {});
    const worker = await make(run);
    worker.start(false);
    await worker.idle();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipping 3 saved task\(s\) of retired kinds \(evidence, matrix, review\)/));
    expect(run).not.toHaveBeenCalled();
    const { listResearchJobs } = await import("../src/research/jobs.js");
    const saved = () => readStore<any[]>(id, "jobs", []);
    // Interrupted ones are paused (so they cannot block idle checks or removal); nothing is dropped.
    expect(saved().find(j => j.id === "old-matrix")).toEqual(matrix);
    for (const old of [evidence, review]) {
      expect(saved().find(j => j.id === old.id)).toMatchObject({ kind: old.kind, items: old.items, state: "paused", message: expect.stringContaining("retired workflow") });
    }
    expect(listResearchJobs(id).some(j => ["queued", "running"].includes(j.state))).toBe(false);
    expect(() => worker.control(id, "old-evidence", "resume")).toThrow("retired workflow");
    expect(() => worker.control(id, "old-review", "cancel")).toThrow("retired workflow");
    // A retired task that reaches the queue anyway is skipped with a log line.
    saveStore(id, "jobs", [...saved().filter(j => j.id !== "old-review"), { ...review, state: "queued" }]);
    (worker as any).queue.push({ projectId: id, jobId: "old-review" });
    (worker as any).kick(); await worker.idle();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping saved review task old-review"));
    // Library indexing keeps working next to the old records.
    worker.create(id, { kind: "library-index", keys: ["alpha"] }); await worker.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(saved().map(j => j.id)).toEqual(expect.arrayContaining(["old-evidence", "old-matrix", "old-review"]));
  });
  it("defers remaining library items when one paper is rate limited", async () => {
    const run = vi.fn(async (_id, _dir, _kind, key) => { if (key === "alpha") throw new Error("Semantic Scholar HTTP 429 rate limited"); });
    const worker = await make(run);
    worker.create(id, { kind: "library-index", keys: ["alpha", "beta"] });
    await worker.idle();
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(run).toHaveBeenCalledTimes(1);
    expect(listResearchJobs(id)[0]).toMatchObject({ state: "queued", items: [{ key: "alpha", state: "error" }, { key: "beta", state: "pending" }] });
  });
  it("interrupts a pending paper download and does not replace cancellation with a missing-source result", async () => {
    const { getPaperContent, readPaperStore } = await import("../src/papers.js");
    const { withResearchOperation } = await import("../src/research/store.js");
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const request = vi.fn(async (_url, opts) => new Promise((_resolve, reject) => {
      const signal = opts.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered();
    }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const result = withResearchOperation(controller.signal, () => getPaperContent(id, dir, "alpha"));
    const assertion = expect(result).rejects.toThrow();
    await started; controller.abort(); await assertion;
    expect(readPaperStore(id)).toEqual({});
    expect(request.mock.calls.every(([, opts]) => opts.signal.aborted)).toBe(true);
  });
});
