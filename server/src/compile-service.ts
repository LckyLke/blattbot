/**
 * Working-tree compiles of a project. Every caller — the /compile route, the
 * refresh after an agent turn, the agent's own compile_latex — goes through
 * compileWorkingTree, which
 *  - runs one build per project at a time (they share one build dir),
 *  - lets a request for the same content join the build already running,
 *  - reuses the last successful build when the sources did not change, and
 *  - keeps the last result on disk, so /pdf works again after a restart.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compilePublic, lastCompile } from "./app-state.js";
import { compileProject, projectPdfPath, resolveTexProgram, type CompileResult } from "./compile.js";
import { buildDir, getProject, projectDir } from "./config.js";
import { broadcast } from "./events.js";
import { readJsonFile, writeJsonFile } from "./jsonfile.js";
import { findMainTex } from "./latex.js";
import { projectFingerprint } from "./project-fingerprint.js";
import { loadSettings } from "./settings.js";

export interface CompileRecord extends CompileResult {
  /** Identifies this result; the PDF viewer reloads only when it changes. */
  version: string;
  /** Hash of the sources, engine choice and main file it was built from (absent: not reusable). */
  fingerprint?: string;
  at: string;
  /** This request was answered with an earlier build of the same content. */
  reused?: boolean;
}

interface Stored {
  last?: CompileRecord;
  lastOk?: CompileRecord;
}

const stored = new Map<string, Stored>();
const running = new Map<string, { fingerprint: string; promise: Promise<CompileRecord> }>();
const tails = new Map<string, Promise<unknown>>();

const statePath = (projectId: string) => join(buildDir(projectId), "last-compile.json");

function load(projectId: string): Stored {
  let state = stored.get(projectId);
  if (state) return state;
  state = readJsonFile<Stored>(statePath(projectId), {});
  if (!state || typeof state !== "object") state = {};
  stored.set(projectId, state);
  return state;
}

function save(projectId: string, state: Stored): void {
  stored.set(projectId, state);
  try {
    mkdirSync(buildDir(projectId), { recursive: true });
    writeJsonFile(statePath(projectId), state);
  } catch (err: any) {
    console.warn(`BlattBot: could not save the compile result of ${projectId}: ${err?.message ?? err}`);
  }
}

/**
 * The last compile of the working tree: from memory, else from the build
 * dir (after a restart), else a PDF an earlier build left there.
 */
export function getLastCompile(projectId: string): CompileRecord | null {
  const state = load(projectId);
  if (state.last) {
    lastCompile.set(projectId, state.last);
    return state.last;
  }
  const project = getProject(projectId);
  const main = project?.mainTex ?? (project ? findMainTex(projectDir(projectId)) : undefined);
  if (!main) return null;
  const pdfPath = projectPdfPath(projectId, main);
  if (!existsSync(pdfPath)) return null;
  const found: CompileRecord = {
    ok: true,
    engine: "cached",
    mainTex: main,
    pdfPath,
    errors: [],
    logTail: "",
    durationMs: 0,
    version: `found-${pdfPath}`,
    at: new Date().toISOString(),
  };
  stored.set(projectId, { last: found });
  lastCompile.set(projectId, found);
  return found;
}

/** The content a build would see: sources + engine choice + main file. */
export async function compileFingerprint(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  const project = getProject(projectId);
  const main = project?.mainTex ?? findMainTex(dir) ?? "";
  const { program } = main ? resolveTexProgram(dir, main, project?.overleafCompiler) : { program: "" };
  return createHash("sha256")
    .update(await projectFingerprint(dir))
    .update(`\0${program}\0${loadSettings().engine}\0${main}`)
    .digest("hex");
}

/** compileWorkingTree calls in progress per project (waiting ones included). */
const active = new Map<string, number>();
const idleWaiters = new Map<string, (() => void)[]>();

function enter(projectId: string): void {
  active.set(projectId, (active.get(projectId) ?? 0) + 1);
}

function leave(projectId: string): void {
  const left = (active.get(projectId) ?? 1) - 1;
  if (left > 0) {
    active.set(projectId, left);
    return;
  }
  active.delete(projectId);
  for (const wake of idleWaiters.get(projectId) ?? []) wake();
  idleWaiters.delete(projectId);
}

/** Is a compile of this project running (or waiting to run) right now? */
export function isCompiling(projectId: string): boolean {
  return active.has(projectId);
}

/** Resolves once no compile of the project is running or waiting. */
export function compileIdle(projectId: string): Promise<void> {
  if (!active.has(projectId)) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.set(projectId, [...(idleWaiters.get(projectId) ?? []), resolve]));
}

/** One build per project at a time, in arrival order. */
async function withCompileLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  tails.set(projectId, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(projectId) === tail) tails.delete(projectId);
  }
}

export interface CompileOptions {
  /** Build even when the last successful build has the same content. */
  force?: boolean;
}

function record(projectId: string, result: CompileResult, fingerprint: string | undefined): CompileRecord {
  const rec: CompileRecord = { ...result, version: randomUUID(), at: new Date().toISOString(), ...(fingerprint ? { fingerprint } : {}) };
  const state = load(projectId);
  save(projectId, { last: rec, lastOk: rec.ok ? rec : state.lastOk });
  lastCompile.set(projectId, rec);
  return rec;
}

/**
 * Compile the project's working tree (see the module comment). Broadcasts
 * compile_start before a real build and `compile` with every result, reused
 * ones included, so every open tab shows the newest PDF.
 */
export async function compileWorkingTree(projectId: string, options: CompileOptions = {}): Promise<CompileRecord> {
  if (!getProject(projectId)) throw new Error("unknown project");
  // Counted from the call on (synchronously), so isCompiling is already true
  // when a caller hands over right after starting a build.
  enter(projectId);
  try {
    return await compileLocked(projectId, options);
  } finally {
    leave(projectId);
  }
}

async function compileLocked(projectId: string, options: CompileOptions): Promise<CompileRecord> {
  const wanted = await compileFingerprint(projectId);
  const current = running.get(projectId);
  if (current && current.fingerprint === wanted) return current.promise;
  return withCompileLock(projectId, async () => {
    const project = getProject(projectId);
    if (!project) throw new Error("unknown project");
    // The sources may have moved while this request waited for the lock.
    const fingerprint = await compileFingerprint(projectId);
    const ok = load(projectId).lastOk;
    if (!options.force && ok?.fingerprint === fingerprint && ok.pdfPath && existsSync(ok.pdfPath)) {
      const reused: CompileRecord = { ...ok, reused: true };
      save(projectId, { last: ok, lastOk: ok });
      lastCompile.set(projectId, ok);
      broadcast(projectId, { type: "compile", ...publicCompile(reused) });
      return reused;
    }
    broadcast(projectId, { type: "compile_start" });
    const promise = (async () => {
      let result: CompileResult;
      try {
        result = await compileProject(projectId, projectDir(projectId), project.mainTex);
      } catch (err) {
        broadcast(projectId, { type: "compile", ...publicCompile(failedRecord(project.mainTex, err)) });
        throw err;
      }
      // Files that changed during the build make it unfit for reuse.
      const after = await compileFingerprint(projectId).catch(() => "");
      const rec = record(projectId, result, after === fingerprint ? fingerprint : undefined);
      broadcast(projectId, { type: "compile", ...publicCompile(rec) });
      return rec;
    })();
    running.set(projectId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (running.get(projectId)?.promise === promise) running.delete(projectId);
    }
  });
}

function failedRecord(mainTex: string | undefined, err: unknown): CompileRecord {
  return {
    ok: false,
    engine: "none",
    mainTex: mainTex ?? "",
    errors: [String((err as Error)?.message ?? err)],
    logTail: "",
    durationMs: 0,
    version: randomUUID(),
    at: new Date().toISOString(),
  };
}

/** The result as the UI receives it: no file paths. */
export function publicCompile(r: CompileRecord) {
  return compilePublic(r);
}

/** Forget a removed project's compile state. */
export function forgetCompiles(projectId: string): void {
  stored.delete(projectId);
  running.delete(projectId);
  lastCompile.delete(projectId);
}
