import { existsSync } from "node:fs";
import { listProjects, projectDir } from "../config.js";
import { readAllBibEntries } from "../citations.js";
import {
  buildGraph,
  graphBuildActive,
  readGraph,
  type CitationGraph,
} from "./graph.js";
import { digest, readStore, saveStore } from "./store.js";

interface Attempt {
  hash: string;
  failures: number;
  retryAt: number;
}
export interface GraphIndexStatus {
  state: "empty" | "queued" | "building" | "ready" | "waiting";
  total: number;
  completed: number;
  pending: number;
  currentKey?: string;
  retryAt?: string;
}
interface Job {
  dir: string;
  keys: string[];
}
interface Dependencies {
  projects: () => { id: string; dir: string }[];
  hashes: (dir: string) => Record<string, string>;
  graph: typeof readGraph;
  build: typeof buildGraph;
  active: typeof graphBuildActive;
  clock: () => number;
}
const defaults: Dependencies = {
  projects: () =>
    listProjects()
      .map((p) => ({ id: p.id, dir: projectDir(p.id) }))
      .filter((p) => existsSync(p.dir)),
  hashes: (dir) =>
    Object.fromEntries(
      readAllBibEntries(dir)
        .filter(({ entry }) => entry.type !== "string")
        .map(({ entry }) => [entry.key, digest(entry.fields)]),
    ),
  graph: readGraph,
  build: buildGraph,
  active: graphBuildActive,
  clock: Date.now,
};
/** One background worker shared by all projects. No model calls; failed lookups
 * retain a persisted backoff so opening/reloading projects cannot hammer indexes. */
export class GraphIndexer {
  private deps: Dependencies;
  private jobs = new Map<string, Job>();
  private current?: { id: string; key: string };
  private worker?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private started = false;
  private cooldownUntil = 0;
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
  }
  start(intervalMs = 15_000) {
    if (this.started) return;
    this.started = true;
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    this.timer.unref();
  }
  scan() {
    if (this.controller.signal.aborted) return;
    const projects = this.deps.projects();
    const existing = new Set(projects.map((p) => p.id));
    for (const id of this.jobs.keys())
      if (!existing.has(id)) this.jobs.delete(id);
    for (const { id, dir } of projects) {
      try {
        this.request(id, dir);
      } catch {
        /* retry unreadable/changing files next scan */
      }
    }
  }
  request(id: string, dir: string, retry = false): GraphIndexStatus {
    if (this.controller.signal.aborted) return this.status(id, dir);
    const hashes = this.deps.hashes(dir);
    const graph = this.deps.graph(id, dir);
    const attempts = readStore<Record<string, Attempt>>(
      id,
      "graph-attempts",
      {},
    );
    let changed = false;
    for (const key of Object.keys(attempts)) {
      if (
        !hashes[key] ||
        attempts[key].hash !== hashes[key] ||
        (retry && !(this.current?.id === id && this.current.key === key))
      ) {
        delete attempts[key];
        changed = true;
      }
    }
    if (changed) saveStore(id, "graph-attempts", attempts);
    const needed = new Set([
      ...graph.pendingKeys,
      ...Object.keys(graph.errors).filter((key) => hashes[key]),
    ]);
    const keys = [...needed].filter(
      (key) =>
        hashes[key] &&
        (attempts[key]?.retryAt ?? 0) <= this.deps.clock() &&
        !(this.current?.id === id && this.current.key === key),
    );
    if (keys.length) this.jobs.set(id, { dir, keys });
    else this.jobs.delete(id);
    this.kick();
    return this.status(id, dir);
  }
  status(id: string, dir: string): GraphIndexStatus {
    const graph = this.deps.graph(id, dir);
    const keys = [...new Set(graph.nodes.flatMap((node) => node.keys))];
    const missing = new Set([
      ...graph.pendingKeys,
      ...Object.keys(graph.errors).filter((key) => keys.includes(key)),
    ]);
    const running = this.current?.id === id;
    const times = Object.entries(
      readStore<Record<string, Attempt>>(id, "graph-attempts", {}),
    )
      .filter(([key]) => missing.has(key))
      .map(([, attempt]) => attempt.retryAt)
      .filter((time) => time > this.deps.clock());
    return {
      state: !keys.length
        ? "empty"
        : running
          ? "building"
          : this.cooldownUntil > this.deps.clock() && missing.size
            ? "waiting"
            : this.jobs.has(id)
              ? "queued"
              : missing.size
                ? "waiting"
                : "ready",
      total: keys.length,
      completed: keys.length - missing.size,
      pending: missing.size,
      currentKey: running ? this.current?.key : undefined,
      retryAt:
        this.cooldownUntil > this.deps.clock()
          ? new Date(this.cooldownUntil).toISOString()
          : times.length
            ? new Date(Math.min(...times)).toISOString()
            : undefined,
    };
  }
  private kick() {
    if (
      this.worker ||
      !this.jobs.size ||
      this.controller.signal.aborted ||
      this.cooldownUntil > this.deps.clock()
    )
      return;
    // Defer so request/status never waits for network and the promise is set
    // before another request can try to start a second worker.
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .catch(() => {
        this.current = undefined;
        this.jobs.clear();
      })
      .finally(() => {
        this.worker = undefined;
      });
  }
  private async drain() {
    while (this.jobs.size && !this.controller.signal.aborted) {
      const [id, job] = this.jobs.entries().next().value!;
      this.jobs.delete(id);
      if (!this.deps.projects().some((p) => p.id === id)) continue;
      if (this.deps.active(id)) continue; // A manual/Codex refresh owns the lock; next scan retries.
      const key = job.keys.shift()!;
      // Reconcile removals/edits that happened while this project was queued.
      const hashes = this.deps.hashes(job.dir);
      if (!hashes[key]) {
        this.request(id, job.dir);
        continue;
      }
      this.current = { id, key };
      let result: CitationGraph | undefined;
      let failure = "";
      try {
        result = await this.deps.build(id, job.dir, [key], {
          signal: this.controller.signal,
        });
      } catch (error: any) {
        if (!this.controller.signal.aborted)
          failure = error.message ?? String(error);
      }
      if (this.controller.signal.aborted) break;
      const attempts = readStore<Record<string, Attempt>>(
        id,
        "graph-attempts",
        {},
      );
      if (failure || result?.errors[key] || result?.pendingKeys.includes(key)) {
        const failures =
          attempts[key]?.hash === hashes[key] ? attempts[key].failures + 1 : 1;
        // Retry transient outages but retain unknown papers as visible gaps.
        attempts[key] = {
          hash: hashes[key],
          failures,
          retryAt:
            this.deps.clock() +
            Math.min(6 * 60 * 60_000, 60_000 * 5 ** Math.min(failures - 1, 4)),
        };
      } else delete attempts[key];
      saveStore(id, "graph-attempts", attempts);
      this.current = undefined;
      // Requeue this project's remaining sources after other projects, including
      // citations added while the last request was in flight. No 20-paper stop.
      this.request(id, job.dir);
      if (/HTTP (429|503)/.test(failure || result?.errors[key] || "")) {
        this.cooldownUntil = this.deps.clock() + 60_000;
        break;
      }
    }
    this.current = undefined;
  }
  /** Test/lifecycle boundary: background work is awaited and abortable on shutdown. */
  async idle() {
    await this.worker;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    this.jobs.clear();
    await this.worker;
  }
}
