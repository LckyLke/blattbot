import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIndexer } from "../src/research/graph-indexer.js";
import type { CitationGraph, buildGraph } from "../src/research/graph.js";

describe("automatic citation graph indexing", () => {
  let root: string;
  let Indexer: typeof GraphIndexer;
  let workers: GraphIndexer[];
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "blattbot-indexer-"));
    vi.stubEnv("BLATTBOT_DATA_DIR", root);
    vi.resetModules();
    ({ GraphIndexer: Indexer } = await import(
      "../src/research/graph-indexer.js"
    ));
    workers = [];
  });
  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function fixture(count = 2) {
    let time = Date.now();
    const projects = [{ id: "old-project", dir: "/old-project" }];
    const entries: Record<string, Record<string, string>> = {
      "/old-project": Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`key${i}`, "v1"]),
      ),
    };
    const loaded: Record<string, Record<string, string>> = {};
    const errors: Record<string, Record<string, string>> = {};
    const graph = (id: string, dir: string): CitationGraph => ({
      at: "",
      edges: [],
      errors: errors[id] ?? {},
      truncated: false,
      note: "Fixture",
      pendingKeys: Object.keys(entries[dir]).filter(
        (key) => loaded[id]?.[key] !== entries[dir][key],
      ),
      nodes: Object.keys(entries[dir]).map((key) => ({
        id: key,
        keys: [key],
        title: key,
        inProject: true,
        resolved: loaded[id]?.[key] === entries[dir][key],
        referencesLoaded: loaded[id]?.[key] === entries[dir][key],
      })),
    });
    let behavior: (
      ...args: Parameters<typeof buildGraph>
    ) => Promise<void> = async () => {};
    const build = vi.fn(async (...args: Parameters<typeof buildGraph>) => {
      const [id, dir, keys, options] = args;
      const key = keys![0];
      const hash = entries[dir][key];
      await behavior(...args);
      options?.signal?.throwIfAborted();
      if (!errors[id]?.[key]) (loaded[id] ??= {})[key] = hash;
      return graph(id, dir);
    });
    const active = vi.fn(() => false);
    const deps = {
      projects: () => projects,
      hashes: (dir: string) => ({ ...entries[dir] }),
      graph,
      build,
      active,
      clock: () => time,
    };
    const create = () => {
      const worker = new Indexer(deps);
      workers.push(worker);
      return worker;
    };
    return {
      worker: create(),
      create,
      projects,
      entries,
      loaded,
      errors,
      build,
      active,
      graph,
      behavior: (fn: typeof behavior) => {
        behavior = fn;
      },
      advance: (ms: number) => {
        time += ms;
      },
    };
  }
  it("builds all sources in existing projects on startup, including more than a manual batch", async () => {
    const f = fixture(47);
    f.worker.start();
    expect(f.worker.status("old-project", "/old-project").state).toBe("queued");
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(47);
    expect(f.worker.status("old-project", "/old-project")).toMatchObject({
      state: "ready",
      total: 47,
      completed: 47,
      pending: 0,
    });
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(47);
  });
  it("deduplicates refreshes while a request is in flight and exposes progress", async () => {
    const f = fixture();
    let release!: () => void;
    f.behavior(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.worker.scan();
    await Promise.resolve();
    expect(f.worker.status("old-project", "/old-project")).toMatchObject({
      state: "building",
      currentKey: "key0",
    });
    for (let i = 0; i < 20; i++)
      f.worker.request("old-project", "/old-project");
    f.behavior(async () => {});
    release();
    await f.worker.idle();
    expect(f.build.mock.calls.map((call) => call[2])).toEqual([
      ["key0"],
      ["key1"],
    ]);
  });
  it("processes several projects fairly and discovers projects added later", async () => {
    const f = fixture(3);
    f.projects.push({ id: "second", dir: "/second" });
    f.entries["/second"] = { other: "v1" };
    f.worker.scan();
    await f.worker.idle();
    expect(f.build.mock.calls.map((call) => call[0])).toEqual([
      "old-project",
      "second",
      "old-project",
      "old-project",
    ]);
    f.projects.push({ id: "new-project", dir: "/new" });
    f.entries["/new"] = { fresh: "v1" };
    f.worker.scan();
    await f.worker.idle();
    expect(f.build.mock.calls.at(-1)?.[0]).toBe("new-project");
  });
  it("reuses cached sources and indexes only additions or changed entries", async () => {
    const f = fixture();
    f.loaded["old-project"] = { key0: "v1", key1: "v1" };
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).not.toHaveBeenCalled();
    f.entries["/old-project"].key1 = "v2";
    f.entries["/old-project"].added = "v1";
    f.worker.request("old-project", "/old-project");
    await f.worker.idle();
    expect(f.build.mock.calls.map((call) => call[2])).toEqual([
      ["key1"],
      ["added"],
    ]);
  });
  it("reconciles edits and removals during a lookup without losing new work", async () => {
    const f = fixture();
    let release!: () => void;
    f.behavior(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.worker.scan();
    await Promise.resolve();
    f.entries["/old-project"].key0 = "v2";
    delete f.entries["/old-project"].key1;
    f.entries["/old-project"].added = "v1";
    f.behavior(async () => {});
    release();
    await f.worker.idle();
    // The stale response is retried immediately because its entry version changed.
    expect(f.build.mock.calls.map((call) => call[2])).toEqual([
      ["key0"],
      ["key0"],
      ["added"],
    ]);
    expect(f.worker.status("old-project", "/old-project").state).toBe("ready");
  });
  it("keeps unavailable sources visible, retries with persisted backoff, and continues other sources", async () => {
    const f = fixture();
    f.errors["old-project"] = { key0: "Paper cannot be resolved reliably" };
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(2);
    expect(f.worker.status("old-project", "/old-project")).toMatchObject({
      state: "waiting",
      pending: 1,
      completed: 1,
      retryAt: expect.any(String),
    });
    await f.worker.stop();
    const restarted = f.create();
    restarted.scan();
    await restarted.idle();
    expect(f.build).toHaveBeenCalledTimes(2);
    f.advance(60_001);
    restarted.scan();
    await restarted.idle();
    expect(f.build).toHaveBeenCalledTimes(3);
    f.advance(60_001);
    restarted.scan();
    await restarted.idle();
    expect(f.build).toHaveBeenCalledTimes(3);
    f.advance(240_000);
    delete f.errors["old-project"].key0;
    restarted.scan();
    await restarted.idle();
    expect(f.build).toHaveBeenCalledTimes(4);
    expect(restarted.status("old-project", "/old-project").state).toBe("ready");
  });
  it("respects provider rate limits before trying more queued papers", async () => {
    const f = fixture(5);
    f.errors["old-project"] = { key0: "Source service returned HTTP 429" };
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(1);
    f.worker.request("old-project", "/old-project");
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.worker.status("old-project", "/old-project").state).toBe(
      "waiting",
    );
    f.advance(60_001);
    delete f.errors["old-project"].key0;
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(6);
  });
  it("allows explicit retry without waiting for a failed paper's backoff", async () => {
    const f = fixture(1);
    f.errors["old-project"] = { key0: "Temporary failure" };
    f.worker.scan();
    await f.worker.idle();
    delete f.errors["old-project"].key0;
    f.worker.request("old-project", "/old-project", true);
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(2);
    expect(f.worker.status("old-project", "/old-project").state).toBe("ready");
  });
  it("waits for a manual graph operation and does not fetch deleted projects", async () => {
    const f = fixture();
    f.active.mockReturnValue(true);
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).not.toHaveBeenCalled();
    f.active.mockReturnValue(false);
    f.worker.scan();
    f.projects.splice(0);
    await f.worker.idle();
    expect(f.build).not.toHaveBeenCalled();
  });
  it("aborts in-flight retrieval and prevents more work on server shutdown", async () => {
    const f = fixture();
    f.behavior(
      async (_id, _dir, _keys, options) =>
        new Promise((_, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(options!.signal!.reason),
            { once: true },
          );
        }),
    );
    f.worker.scan();
    await Promise.resolve();
    await f.worker.stop();
    f.worker.scan();
    await f.worker.idle();
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.build.mock.calls[0][3]?.signal?.aborted).toBe(true);
    expect(f.loaded["old-project"]).toBeUndefined();
  });
  it("reports an empty bibliography without scheduling remote work", async () => {
    const f = fixture(0);
    f.worker.scan();
    await f.worker.idle();
    expect(f.worker.status("old-project", "/old-project")).toMatchObject({
      state: "empty",
      total: 0,
    });
    expect(f.build).not.toHaveBeenCalled();
  });
});
