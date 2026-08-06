import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { BIN_DIR, buildDir } from "./config.js";
import { archiveZip } from "./git.js";
import { findMainTex } from "./latex.js";
import { loadSettings } from "./settings.js";

const execFileP = promisify(execFile);

export interface CompileResult {
  ok: boolean;
  engine: string;
  mainTex: string;
  pdfPath?: string;
  /** Human-readable error excerpts, empty when ok. */
  errors: string[];
  /** Tail of the raw log, for the curious. */
  logTail: string;
  durationMs: number;
}

export interface Engine {
  name: string;
  path: string;
}

/**
 * Engines to try, best first. latexmk drives a full local TeX distribution the
 * way Overleaf does — pdfTeX primitives, biber/bibtex/makeindex reruns — so it
 * reproduces an Overleaf build most faithfully; pdflatex is the same engine
 * without the rerun logic. tectonic comes last: it is self-contained and
 * fetches missing packages on demand (which rescues an incomplete TeX tree),
 * but it is XeTeX-based, so pdfTeX-only packages break on it — pdfx, for one,
 * cannot stamp /CreationDate without \pdfcreationdate and stops the build.
 */
export const ENGINE_PRIORITY = ["latexmk", "pdflatex", "tectonic"] as const;

/** Engine names to try, best first: the configured one, then the rest as fallback. */
export function engineOrder(preferred?: string): string[] {
  const rest = ENGINE_PRIORITY.filter((name) => name !== preferred);
  return preferred ? [preferred, ...rest] : [...rest];
}

/** name → where it lives (null = looked for, not installed here). */
const engineCache = new Map<string, Engine | null>();

/** Forget the auto-detect results — call after installing an engine into BIN_DIR. */
export function resetEngineCache(): void {
  engineCache.clear();
}

async function which(cmd: string): Promise<string | undefined> {
  try {
    // `which` does not exist on Windows; `where` may print several matches.
    const finder = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileP(finder, [cmd]);
    return stdout.split(/\r?\n/).find((l) => l.trim())?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function findEngine(name: string): Promise<Engine | undefined> {
  // Windows executables carry an extension; a bare name is never spawnable.
  const candidates =
    process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const file of candidates) {
    const local = join(BIN_DIR, file);
    if (existsSync(local)) return { name, path: local };
  }
  const p = await which(name);
  return p ? { name, path: p } : undefined;
}

/**
 * Node refuses to execFile .cmd/.bat without a shell (CVE-2024-27980). Batch
 * engines (wrapper shims are common on Windows) go through cmd.exe with every
 * arg double-quoted — execFile's shell mode joins args without any quoting.
 */
function spawnEngine(path: string, args: string[], opts: Parameters<typeof execFileP>[2]) {
  const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(path);
  if (!batch) return execFileP(path, args, opts);
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return execFileP(quote(path), args.map(quote), { ...opts, shell: true });
}

async function resolveEngine(name: string): Promise<Engine | null> {
  const cached = engineCache.get(name);
  if (cached !== undefined) return cached;
  const found = (await findEngine(name)) ?? null;
  engineCache.set(name, found);
  return found;
}

/**
 * Every engine installed on this machine, best first — a compile walks down
 * this list, so the ones after the first are the fallbacks. An explicit
 * preference (Settings → engine) goes to the front rather than replacing the
 * list: a preferred engine that is missing or cannot build the document still
 * leaves the others to try.
 */
export async function detectEngines(preferred?: string): Promise<Engine[]> {
  const found: Engine[] = [];
  for (const name of engineOrder(preferred)) {
    const hit = await resolveEngine(name);
    if (hit) found.push(hit);
  }
  return found;
}

/** The engine a compile would reach for first (health check, doctor, first run). */
export async function detectEngine(preferred?: string): Promise<Engine | null> {
  return (await detectEngines(preferred))[0] ?? null;
}

/** Pull error lines out of a LaTeX/tectonic log. */
export function parseErrors(log: string): string[] {
  const errors: string[] = [];
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // tectonic style: "error: ..." — classic TeX style: lines starting with "!"
    if (/^error[:!]/i.test(line) || line.startsWith("! ")) {
      const context: string[] = [line.trim()];
      // Grab following l.<num> context lines that TeX prints after an error.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j];
        if (/^(l\.\d+|<|\s*\^)/.test(next) || /^error/i.test(next) === false && next.trim().startsWith("l.")) {
          context.push(next.trim());
        } else if (next.trim() === "") {
          break;
        }
      }
      errors.push(context.join("\n"));
    }
  }
  return errors.slice(0, 20);
}

export async function compileProject(projectId: string, projectPath: string, mainTex?: string): Promise<CompileResult> {
  return compileTree(projectPath, buildDir(projectId), mainTex);
}

function engineArgs(engine: string, outDir: string, main: string): string[] {
  if (engine === "tectonic") return ["--outdir", outDir, "--keep-logs", "--chatter", "minimal", main];
  if (engine === "latexmk") {
    // -g: always reprocess. latexmk records a failed run in .fdb_latexmk and
    // then refuses to redo anything until a source file changes ("Nothing to
    // do ... gave an error in previous invocation"), which hides the actual
    // TeX error from the second compile onwards. This build dir is scratch
    // space for a verification compile, so a full run every time is the point.
    return ["-g", "-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outDir}`, main];
  }
  return ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${outDir}`, main];
}

/**
 * Failures that mean "this engine could not build the document" rather than
 * "the document is wrong": a style/class file the local TeX tree lacks (which
 * tectonic downloads on demand), a helper binary the engine could not spawn,
 * or a feature it does not have. Everything else — undefined control sequence,
 * missing $, runaway argument — fails the same way on every engine, so trying
 * the next one only costs the user another full compile.
 */
const ENGINE_SPECIFIC = [
  /file\s+[`'"]?[^\s`'"]+\.(sty|cls|def|fd|cfg|enc)['"`]?\s+not found/i,
  /(font|encoding)\b[^\n]*\b(not (found|loadable)|cannot be found)/i,
  /shell[- ]?escape|write18/i,
  /no such file or directory/i,
  /not properly supported|requires (pdf|lua|xe)(la)?tex/i,
];

/** Is a failed attempt worth repeating with the next engine? */
export function isEngineSpecificFailure(errors: string[]): boolean {
  // No TeX error at all means the engine itself fell over — crash, timeout, or
  // a helper it could not run (tectonic exits "No such file or directory" when
  // a biblatex project has no biber on PATH). Always worth another engine.
  if (errors.length === 0) return true;
  return errors.some((e) => ENGINE_SPECIFIC.some((re) => re.test(e)));
}

/** Where a compile of `main` leaves its PDF. */
function pdfPathFor(outDir: string, main: string): string {
  return join(outDir, main.split("/").pop()!.replace(/\.tex$/, ".pdf"));
}

/** One engine run over a source tree; the caller decides what a failure means. */
async function runEngine(
  engine: Engine,
  sourceDir: string,
  outDir: string,
  main: string,
): Promise<{ ok: boolean; retryable: boolean; errors: string[]; logTail: string }> {
  // The previous attempt's log would otherwise be read back as this one's errors.
  try {
    for (const f of readdirSync(outDir).filter((f) => f.endsWith(".log"))) {
      rmSync(join(outDir, f), { force: true });
    }
  } catch {
    /* nothing to clean */
  }

  let combined = "";
  let ok = true;
  try {
    const { stdout, stderr } = await spawnEngine(engine.path, engineArgs(engine.name, outDir, main), {
      cwd: sourceDir,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
      env: { ...process.env, PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}` },
    });
    combined = stdout + "\n" + stderr;
  } catch (err: any) {
    ok = false;
    combined = String(err.stdout ?? "") + "\n" + String(err.stderr ?? "") + "\n" + String(err.message ?? "");
  }

  // Include the .log file if the engine kept one — that's where TeX errors live.
  try {
    const logs = readdirSync(outDir).filter((f) => f.endsWith(".log"));
    for (const f of logs) combined += "\n" + readFileSync(join(outDir, f), "utf8");
  } catch {
    /* no log */
  }

  const built = ok && existsSync(pdfPathFor(outDir, main));
  const errors = built ? [] : parseErrors(combined);
  // Judge the retry on what TeX itself said: the placeholder below is added
  // for the user's benefit and would otherwise read like a document error.
  const retryable = !built && isEngineSpecificFailure(errors);
  if (!built && errors.length === 0) {
    errors.push(`Compilation failed (${engine.name}) — see log tail for details.`);
  }

  return { ok: built, retryable, errors, logTail: combined.split("\n").slice(-60).join("\n") };
}

/**
 * Run the installed engines on a source tree, best first, PDF and logs into
 * outDir. A failure that looks engine-specific (see isEngineSpecificFailure)
 * drops through to the next engine; a broken document stops at the first one.
 */
async function compileTree(sourceDir: string, outDir: string, mainTex?: string): Promise<CompileResult> {
  const started = Date.now();
  const main = mainTex ?? findMainTex(sourceDir);
  if (!main) {
    return {
      ok: false, engine: "none", mainTex: "", errors: ["No .tex file with \\documentclass found in the project."],
      logTail: "", durationMs: Date.now() - started,
    };
  }
  const engines = await detectEngines(loadSettings().engine || undefined);
  if (engines.length === 0) {
    return {
      ok: false, engine: "none", mainTex: main,
      errors: ["No LaTeX engine found. Install a TeX distribution (latexmk/pdflatex) or tectonic."],
      logTail: "", durationMs: Date.now() - started,
    };
  }

  mkdirSync(outDir, { recursive: true });

  const tried: { engine: string; errors: string[]; logTail: string }[] = [];
  for (const engine of engines) {
    const attempt = await runEngine(engine, sourceDir, outDir, main);
    if (attempt.ok) {
      return {
        ok: true,
        engine: engine.name,
        mainTex: main,
        pdfPath: pdfPathFor(outDir, main),
        errors: [],
        // Explain an engine badge the user did not expect to see.
        logTail: [...tried.map(fallbackNote), attempt.logTail].join("\n"),
        durationMs: Date.now() - started,
      };
    }
    tried.push({ engine: engine.name, ...attempt });
    if (!attempt.retryable) break;
  }

  // Nothing built it: lead with the first engine's verdict — that is the one
  // the user asked for — and keep every log for the details view. A stale PDF
  // from an earlier build stays addressable so the viewer can keep showing it.
  const [first, ...rest] = tried;
  const pdfPath = pdfPathFor(outDir, main);
  return {
    ok: false,
    engine: first.engine,
    mainTex: main,
    pdfPath: existsSync(pdfPath) ? pdfPath : undefined,
    errors: rest.length
      ? [...first.errors, `Also tried ${rest.map((t) => t.engine).join(", ")} — see the log tail.`]
      : first.errors,
    logTail: tried.map((t) => `--- ${t.engine} ---\n${t.logTail}`).join("\n\n"),
    durationMs: Date.now() - started,
  };
}

/** One-line "why we moved on" note for an engine that could not build it. */
function fallbackNote(t: { engine: string; errors: string[] }): string {
  const why = t.errors[0]?.split("\n")[0] ?? "no error reported";
  return `note: ${t.engine} could not build this document (${why}) — retried with the next engine.`;
}

/** Fixed names inside a rev-<sha> build cache dir. */
const REV_PDF = "output.pdf";
const REV_RESULT = "result.json";
/** How many per-revision build caches to keep per project. */
const REV_CACHE_KEEP = 3;

/** Where compileRev leaves the PDF of a committed revision (may not exist yet). */
export function revPdfPath(projectId: string, sha: string): string {
  return join(buildDir(projectId), `rev-${sha}`, REV_PDF);
}

/**
 * Compile the project's tree AS COMMITTED at a sha (never the working copy):
 * `git archive` the revision into a per-sha cache dir under the build area and
 * run the engine there. A commit's tree is immutable, so an existing cached
 * PDF short-circuits the whole thing; failed builds are never cached.
 */
export async function compileRev(
  projectId: string,
  projectPath: string,
  sha: string,
  mainTex?: string,
): Promise<CompileResult> {
  const revDir = join(buildDir(projectId), `rev-${sha}`);
  const pdfPath = join(revDir, REV_PDF);
  if (existsSync(pdfPath)) {
    // Freshen the cache dir so eviction keeps recently USED revisions.
    const now = new Date();
    try {
      utimesSync(revDir, now, now);
    } catch {
      /* best effort */
    }
    let cached: Partial<CompileResult> = {};
    try {
      cached = JSON.parse(readFileSync(join(revDir, REV_RESULT), "utf8"));
    } catch {
      /* stale/corrupt sidecar — the PDF alone is enough */
    }
    return {
      ok: true,
      engine: typeof cached.engine === "string" ? cached.engine : "cached",
      mainTex: typeof cached.mainTex === "string" ? cached.mainTex : "",
      pdfPath,
      errors: [],
      logTail: typeof cached.logTail === "string" ? cached.logTail : "",
      durationMs: 0,
    };
  }

  // Materialize the committed tree next to where the PDF will land.
  const treeDir = join(revDir, "tree");
  rmSync(revDir, { recursive: true, force: true });
  mkdirSync(treeDir, { recursive: true });
  const entries = unzipSync(new Uint8Array(await archiveZip(projectPath, sha)));
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/") || name.split("/").includes("..")) continue;
    const dest = join(treeDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(data));
  }

  // The registered main may not exist at this revision — fall back to detection.
  const main = mainTex && existsSync(join(treeDir, mainTex)) ? mainTex : undefined;
  const result = await compileTree(treeDir, revDir, main);
  if (result.pdfPath) {
    renameSync(result.pdfPath, pdfPath);
    result.pdfPath = pdfPath;
    const { pdfPath: _omit, ...rest } = result;
    writeFileSync(join(revDir, REV_RESULT), JSON.stringify(rest));
  }
  evictRevCaches(projectId);
  return result;
}

/** Drop all but the REV_CACHE_KEEP most recently touched rev caches of a project. */
function evictRevCaches(projectId: string): void {
  const dir = buildDir(projectId);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith("rev-"));
  } catch {
    return;
  }
  const dated = names
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { name: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const e of dated.slice(REV_CACHE_KEEP)) {
    rmSync(join(dir, e.name), { recursive: true, force: true });
  }
}
