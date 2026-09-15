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
afterEach(async () => { await Promise.all(workers.map(w => w.stop())); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function make(run: ConstructorParameters<typeof ResearchJobs>[0]) { const { ResearchJobs } = await import("../src/research/jobs.js"); const worker = new ResearchJobs(run); workers.push(worker); return worker; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
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
    const run = vi.fn(async (_id, _dir, _kind, key) => { if (key === "beta") throw new Error("Missing PDF"); });
    const worker = await make(run); const { listResearchJobs } = await import("../src/research/jobs.js");
    const job = worker.create(id, { kind: "matrix", keys: ["alpha", "beta", "gamma"] });
    expect(worker.create(id, { kind: "matrix", keys: ["alpha", "beta", "gamma"] }).id).toBe(job.id);
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
    const worker = await make(run); const job = worker.create(id, { kind: "matrix", keys: ["alpha", "beta"] });
    await tick(); worker.control(id, job.id, "cancel");
    expect(observed?.aborted).toBe(true);
    release(); await worker.idle();
    expect(readStore(id, "test-result", null)).toBeNull(); expect(run).toHaveBeenCalledTimes(1);
    const { listResearchJobs } = await import("../src/research/jobs.js"); expect(listResearchJobs(id)[0].state).toBe("cancelled");
  });
  it("retains progress over a server restart and resumes pending items on request", async () => {
    const { saveStore } = await import("../src/research/store.js");
    saveStore(id, "jobs", [{ id: "interrupted", kind: "matrix", state: "running", createdAt: "before", updatedAt: "before", context: [], currentKey: "beta", items: [{ key: "alpha", state: "done" }, { key: "beta", state: "pending" }] }]);
    const run = vi.fn(async (_id: string, _dir: string, _kind: string, _key: string) => {}); const worker = await make(run); worker.start(false);
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id)[0].state).toBe("paused"); expect(listResearchJobs(id)[0].currentKey).toBeUndefined(); expect(run).not.toHaveBeenCalled();
    worker.control(id, "interrupted", "resume"); await worker.idle();
    expect(run).toHaveBeenCalledTimes(1); expect(run.mock.calls[0][3]).toBe("beta");
    expect(listResearchJobs(id)[0].state).toBe("completed");
  });
  it("isolates projects and rejects unknown source keys before enqueuing", async () => {
    const worker = await make(async () => {});
    expect(() => worker.create(id, { kind: "matrix", keys: ["ghost"] })).toThrow("Unknown citation");
    const job = worker.create(id, { kind: "matrix", keys: ["alpha"] });
    expect(() => worker.control("another", job.id, "cancel")).toThrow("Unknown research job");
    await worker.idle();
  });
  it("pauses on shutdown and preserves completed results", async () => {
    const { researchSignal } = await import("../src/research/store.js");
    const worker = await make(async () => new Promise((_resolve, reject) => { researchSignal()!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }));
    worker.create(id, { kind: "matrix", keys: ["alpha", "beta"] }); await tick(); await worker.stop();
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id)[0].state).toBe("paused");
    expect(() => worker.create(id, { kind: "matrix", keys: ["gamma"] })).toThrow("shutting down");
  });
  it("pauses on provider limits without failing or repeatedly calling remaining sources", async () => {
    const run = vi.fn(async (): Promise<void> => { throw new Error("Provider HTTP 429 rate limited"); });
    const worker = await make(run);
    const job = worker.create(id, { kind: "matrix", keys: ["alpha", "beta"] });
    await worker.idle();
    const { listResearchJobs } = await import("../src/research/jobs.js");
    expect(listResearchJobs(id)[0]).toMatchObject({ state: "paused", items: [{ key: "alpha", state: "pending" }, { key: "beta", state: "pending" }] });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockResolvedValue(undefined);
    worker.control(id, job.id, "resume"); await worker.idle();
    expect(run).toHaveBeenCalledTimes(3);
    expect(listResearchJobs(id)[0].state).toBe("completed");
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
