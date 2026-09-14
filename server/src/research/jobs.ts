import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getProject, listProjects, projectDir } from "../config.js";
import { readAllBibEntries } from "../citations.js";
import { evidenceView, manuscriptClaims } from "./evidence.js";
import { readMatrix } from "./matrix.js";
import { libraryStatus } from "./library.js";
import { now, readStore, saveStore, withResearchOperation } from "./store.js";

export const jobKind = z.enum([
  "evidence",
  "matrix",
  "review",
  "outline",
  "library-index",
  "strict-audit",
  "evaluation",
]);
export type JobKind = z.infer<typeof jobKind>;
export interface ResearchJob {
  id: string;
  kind: JobKind;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  items: { key: string; state: "pending" | "done" | "error"; error?: string }[];
  context: string[];
  currentKey?: string;
  message?: string;
}
export const createJobSchema = z.object({
  kind: jobKind,
  keys: z.array(z.string().min(1).max(1000)).min(1).max(2000).optional(),
  context: z.array(z.string().max(4000)).max(30).default([]),
});
export const listResearchJobs = (id: string) =>
  readStore<ResearchJob[]>(id, "jobs", []);
type Runner = (
  id: string,
  dir: string,
  kind: JobKind,
  key: string,
  context: string[],
) => Promise<unknown>;
async function defaultRun(
  id: string,
  dir: string,
  kind: JobKind,
  key: string,
  context: string[],
) {
  if (kind === "evidence")
    return (await import("./evidence.js")).verifyClaim(id, dir, key);
  if (kind === "matrix")
    return (await import("./matrix.js")).analyzePaper(id, dir, key);
  if (kind === "review")
    return (await import("./review.js")).reviewManuscript(id, dir, context);
  if (kind === "outline")
    return (await import("./matrix.js")).buildOutline(id, dir);
  if (kind === "library-index")
    return (await import("./library.js")).indexPaper(id, dir, key);
  if (kind === "strict-audit")
    return (await import("./strict.js")).auditUncitedClaims(id, dir);
  return (await import("./evaluation.js")).evaluateCase(id, key);
}
/** Durable item checkpoints; interrupted model requests are never claimed complete. */
export class ResearchJobs {
  private worker?: Promise<void>;
  private queue: { projectId: string; jobId: string }[] = [];
  private current?: {
    projectId: string;
    jobId: string;
    controller: AbortController;
  };
  private stopped = false;
  constructor(private run: Runner = defaultRun) {}
  start() {
    for (const p of listProjects())
      this.updateAll(p.id, (jobs) =>
        jobs.map((j) =>
          ["running", "queued"].includes(j.state)
            ? {
                ...j,
                state: "paused",
                currentKey: undefined,
                updatedAt: now(),
                message:
                  "Interrupted by restart. Resume to continue from the last saved item.",
              }
            : j,
        ),
      );
  }
  private updateAll(
    id: string,
    change: (jobs: ResearchJob[]) => ResearchJob[],
  ) {
    return saveStore(id, "jobs", change(listResearchJobs(id)));
  }
  private patch(
    id: string,
    jobId: string,
    change: (job: ResearchJob) => ResearchJob,
  ) {
    return this.updateAll(id, (jobs) =>
      jobs.map((j) =>
        j.id === jobId ? { ...change(j), updatedAt: now() } : j,
      ),
    ).find((j) => j.id === jobId)!;
  }
  create(id: string, input: z.input<typeof createJobSchema>) {
    if (this.stopped) throw new Error("Research worker is shutting down");
    if (!getProject(id)) throw new Error("Unknown project");
    const args = createJobSchema.parse(input);
    const dir = projectDir(id);
    let keys = args.keys;
    if (args.kind === "evidence") {
      const available = manuscriptClaims(dir).map((c) => c.id);
      keys ??= evidenceView(id, dir)
        .filter((c) => ["unchecked", "stale"].includes(c.status))
        .map((c) => c.id);
      if (keys.some((k) => !available.includes(k)))
        throw new Error("Unknown manuscript claim");
    } else if (["matrix", "library-index"].includes(args.kind)) {
      const available = readAllBibEntries(dir)
        .filter(({ entry }) => entry.type !== "string")
        .map(({ entry }) => entry.key);
      keys ??=
        args.kind === "library-index"
          ? libraryStatus(id, dir).pending
          : available;
      if (keys.some((k) => !available.includes(k)))
        throw new Error("Unknown citation key");
    } else if (args.kind !== "evaluation") keys = ["manuscript"];
    if (!keys?.length)
      throw new Error(
        "Nothing to process. Select sources or refresh a changed item.",
      );
    const unique = [...new Set(keys)];
    const existing = listResearchJobs(id).find(
      (j) =>
        ["queued", "running", "paused"].includes(j.state) &&
        j.kind === args.kind &&
        JSON.stringify(j.items.map((i) => i.key).sort()) ===
          JSON.stringify([...unique].sort()) &&
        JSON.stringify(j.context) === JSON.stringify(args.context),
    );
    if (existing) return existing;
    const job: ResearchJob = {
      id: randomUUID(),
      kind: args.kind,
      state: "queued",
      createdAt: now(),
      updatedAt: now(),
      items: unique.map((key) => ({ key, state: "pending" })),
      context: args.context,
    };
    this.updateAll(id, (jobs) => [...jobs.filter(j => ["queued", "running", "paused"].includes(j.state)), ...jobs.filter(j => !["queued", "running", "paused"].includes(j.state)).slice(-99), job]);
    this.queue.push({ projectId: id, jobId: job.id });
    this.kick();
    return job;
  }
  control(id: string, jobId: string, action: "pause" | "resume" | "cancel") {
    const job = listResearchJobs(id).find((j) => j.id === jobId);
    if (!job) throw new Error("Unknown research job");
    if (action === "resume") {
      if (!["paused", "failed", "cancelled"].includes(job.state))
        throw new Error("This job is not resumable");
      if (this.current?.jobId === jobId)
        throw new Error(
          "The current request is still stopping. Try resume shortly.",
        );
      const dir = projectDir(id);
      const stale = new Set(
        job.kind === "matrix"
          ? readMatrix(id, dir)
              .filter((r) => r.stale)
              .map((r) => r.key)
          : job.kind === "evidence"
            ? evidenceView(id, dir)
                .filter((e) => ["unchecked", "stale"].includes(e.status))
                .map((e) => e.id)
            : job.kind === "library-index"
              ? libraryStatus(id, dir).pending
              : [],
      );
      const updated = this.patch(id, jobId, (j) => ({
        ...j,
        state: "queued",
        message: undefined,
        items: j.items.map((item) =>
          item.state !== "done" || stale.has(item.key)
            ? { key: item.key, state: "pending" }
            : item,
        ),
      }));
      this.queue.push({ projectId: id, jobId });
      this.kick();
      return updated;
    }
    if (job.state === "completed")
      throw new Error("This job has already completed");
    const updated = this.patch(id, jobId, (j) => ({
      ...j,
      state: action === "pause" ? "paused" : "cancelled",
      currentKey: undefined,
      message:
        action === "pause"
          ? "Paused. Saved items are retained."
          : "Cancelled. Completed results are retained.",
    }));
    this.queue = this.queue.filter((item) => item.jobId !== jobId);
    if (this.current?.jobId === jobId) this.current.controller.abort();
    return updated;
  }
  private kick() {
    if (this.worker || this.stopped || !this.queue.length) return;
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.worker = undefined;
        if (!this.stopped && this.queue.length) this.kick();
      });
    // Individual items report errors; unexpected store failures remain observable on restart.
    void this.worker.catch(() => {});
  }
  private async drain() {
    while (this.queue.length && !this.stopped) {
      const next = this.queue.shift()!;
      if (!getProject(next.projectId)) continue;
      const job = listResearchJobs(next.projectId).find(
        (j) => j.id === next.jobId,
      );
      if (!job || !["queued", "running"].includes(job.state)) continue;
      const item = job.items.find((i) => i.state === "pending");
      if (!item) {
        this.patch(next.projectId, job.id, (j) => ({
          ...j,
          state: j.items.some((i) => i.state === "error")
            ? "failed"
            : "completed",
          currentKey: undefined,
        }));
        continue;
      }
      const controller = new AbortController();
      this.current = { ...next, controller };
      this.patch(next.projectId, job.id, (j) => ({
        ...j,
        state: "running",
        currentKey: item.key,
      }));
      try {
        await withResearchOperation(controller.signal, () =>
          this.run(
            next.projectId,
            projectDir(next.projectId),
            job.kind,
            item.key,
            job.context,
          ),
        );
        controller.signal.throwIfAborted();
        this.patch(next.projectId, job.id, (j) => ({
          ...j,
          items: j.items.map((i) =>
            i.key === item.key ? { key: i.key, state: "done" } : i,
          ),
        }));
      } catch (err: any) {
        const message = err.message ?? String(err);
        // Keep indexing other papers when one provider cannot serve this item.
        if (job.kind !== "library-index" && !controller.signal.aborted && /\b(?:429|503|529)\b|rate.?limit|quota|overloaded|insufficient.?(?:credit|balance)/i.test(message)) {
          this.patch(next.projectId, job.id, (j) => ({
            ...j,
            state: "paused",
            currentKey: undefined,
            message: `Service unavailable or usage limit reached. Resume when ready. ${message}`,
          }));
        } else if (!controller.signal.aborted)
          this.patch(next.projectId, job.id, (j) => ({
            ...j,
            items: j.items.map((i) =>
              i.key === item.key
                ? {
                    key: i.key,
                    state: "error",
                    error: message,
                  }
                : i,
            ),
          }));
      } finally {
        this.current = undefined;
      }
      if (!controller.signal.aborted && listResearchJobs(next.projectId).find(j => j.id === job.id)?.state !== "paused") {
        this.patch(next.projectId, job.id, (j) => ({
          ...j,
          state: "queued",
          currentKey: undefined,
        }));
        this.queue.push(next);
      }
    }
  }
  async idle() {
    while (this.worker) await this.worker;
  }
  async stop() {
    this.stopped = true;
    const current = this.current;
    if (current) this.control(current.projectId, current.jobId, "pause");
    for (const item of this.queue)
      this.patch(item.projectId, item.jobId, (j) => ({
        ...j,
        state: "paused",
        message: "Server stopped. Resume when ready.",
      }));
    this.queue = [];
    await this.worker;
  }
}
export const researchJobs = new ResearchJobs();
