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
import { BIN_DIR, buildDir, getProject } from "./config.js";
import { archiveZip } from "./git.js";
import { findMainTex } from "./latex.js";
import { loadSettings } from "./settings.js";

const execFileP = promisify(execFile);

/** The TeX program a document is written for (Overleaf's "compiler" setting). */
export type TexProgram = "pdflatex" | "xelatex" | "lualatex" | "latex";

/** Where the program came from: the main file, the Overleaf project, the build log, or the default. */
export type ProgramSource = "magic comment" | "Overleaf" | "log" | "default";

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
  /** The TeX program the build ran for (tectonic always runs XeTeX). */
  program?: TexProgram;
  programSource?: ProgramSource;
}

const PROGRAM_ALIASES: Record<string, TexProgram> = {
  pdflatex: "pdflatex",
  pdftex: "pdflatex",
  xelatex: "xelatex",
  xetex: "xelatex",
  lualatex: "lualatex",
  luatex: "lualatex",
  latex: "latex",
};

export function normalizeProgram(raw: unknown): TexProgram | undefined {
  return typeof raw === "string" ? PROGRAM_ALIASES[raw.trim().toLowerCase()] : undefined;
}

/** `% !TEX program = xelatex` (or `TS-program`) near the top of a file. */
export function magicProgram(source: string): TexProgram | undefined {
  for (const line of source.split(/\r?\n/).slice(0, 50)) {
    const m = /^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/i.exec(line);
    if (m) return normalizeProgram(m[1]);
  }
  return undefined;
}

/** Magic comment in the main file, else the Overleaf project's compiler, else pdflatex. */
export function resolveTexProgram(
  sourceDir: string,
  main: string,
  overleafCompiler?: string,
): { program: TexProgram; source: ProgramSource } {
  let text = "";
  try {
    text = readFileSync(join(sourceDir, main), "utf8").slice(0, 16_384);
  } catch {
    /* unreadable main file — the engine reports it */
  }
  const fromComment = magicProgram(text);
  if (fromComment) return { program: fromComment, source: "magic comment" };
  const fromOverleaf = normalizeProgram(overleafCompiler);
  if (fromOverleaf) return { program: fromOverleaf, source: "Overleaf" };
  return { program: "pdflatex", source: "default" };
}

/** The compiler the Overleaf project is set to (stored by the Overleaf sync). */
function overleafCompilerOf(projectId: string): string | undefined {
  const value = (getProject(projectId) as { overleafCompiler?: unknown } | undefined)?.overleafCompiler;
  return typeof value === "string" ? value : undefined;
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

/**
 * Engines to try for a document written for `program`, best first. latexmk
 * runs the program itself (-pdf / -xelatex / -lualatex / -pdfdvi); the direct
 * engine is the program's own binary (the "pdflatex" setting means "run the
 * program directly"); tectonic is XeTeX-based, which suits pdfLaTeX and
 * XeLaTeX sources but not LuaLaTeX ones, so those try it last.
 */
export function compileOrder(program: TexProgram, preferred?: string): string[] {
  const direct = program === "latex" ? undefined : program;
  const base = ["latexmk", ...(direct ? [direct] : []), "tectonic"];
  const pick = preferred === "pdflatex" ? direct : preferred;
  let order = pick && base.includes(pick) ? [pick, ...base.filter((name) => name !== pick)] : base;
  if (program === "lualatex" && order[0] === "tectonic") order = [...order.slice(1), "tectonic"];
  return order;
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
  return compileTree(projectPath, buildDir(projectId), mainTex, overleafCompilerOf(projectId));
}

const LATEXMK_PROGRAM_FLAG: Record<TexProgram, string> = {
  pdflatex: "-pdf",
  xelatex: "-xelatex",
  lualatex: "-lualatex",
  latex: "-pdfdvi",
};

function engineArgs(engine: string, outDir: string, main: string, program: TexProgram, force: boolean): string[] {
  if (engine === "tectonic") return ["--outdir", outDir, "--keep-logs", "--chatter", "minimal", main];
  if (engine === "latexmk") {
    // No -g by default: latexmk tracks the dependencies itself and skips work
    // when nothing changed. -g (force) is the retry for a run latexmk refused
    // because the previous one failed ("gave an error in previous invocation"),
    // which would otherwise hide the actual TeX error.
    return [
      ...(force ? ["-g"] : []),
      LATEXMK_PROGRAM_FLAG[program],
      "-interaction=nonstopmode",
      "-halt-on-error",
      `-outdir=${outDir}`,
      main,
    ];
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

/**
 * Errors that name the TeX program the document needs: fontspec's "requires
 * either XeTeX or LuaTeX", luacode's "LuaTeX is required", unicode-math's
 * "Cannot be run with pdfLaTeX", and similar wordings.
 */
const PROGRAM_REQUIRED = [
  /requires\s+(?:either\s+)?(?:the\s+)?(xe|lua)(?:la)?tex/i,
  /\b(xe|lua)(?:la)?tex\s+(?:is\s+)?(?:required|needed)/i,
  /(?:cannot|can't|must not)\s+be\s+(?:run|used|compiled)\s+with\s+(?:pdf)?(?:la)?tex/i,
  /(?:must|has to)\s+be\s+(?:run|compiled|typeset)\s+with\s+(xe|lua)(?:la)?tex/i,
  /only\s+(?:works|runs)\s+with\s+(xe|lua)(?:la)?tex/i,
];

/** The program a failed run's errors ask for, if any. */
export function requiredProgram(errors: string[]): "xelatex" | "lualatex" | undefined {
  for (const error of errors) {
    for (const re of PROGRAM_REQUIRED) {
      const m = re.exec(error);
      if (!m) continue;
      return m[1]?.toLowerCase() === "lua" ? "lualatex" : "xelatex";
    }
  }
  return undefined;
}

/** Is a failed attempt worth repeating with the next engine? */
export function isEngineSpecificFailure(errors: string[]): boolean {
  // No TeX error at all means the engine itself fell over — crash, timeout, or
  // a helper it could not run (tectonic exits "No such file or directory" when
  // a biblatex project has no biber on PATH). Always worth another engine.
  if (errors.length === 0) return true;
  return errors.some((e) => ENGINE_SPECIFIC.some((re) => re.test(e)) || PROGRAM_REQUIRED.some((re) => re.test(e)));
}

/** Where a compile of `main` leaves its PDF. */
function pdfPathFor(outDir: string, main: string): string {
  return join(outDir, main.split("/").pop()!.replace(/\.tex$/, ".pdf"));
}

/** Where a successful working-tree compile of the project leaves its PDF. */
export function projectPdfPath(projectId: string, main: string): string {
  return pdfPathFor(buildDir(projectId), main);
}

function logsIn(outDir: string): string[] {
  try {
    return readdirSync(outDir).filter((f) => f.endsWith(".log"));
  } catch {
    return [];
  }
}

interface Attempt {
  ok: boolean;
  retryable: boolean;
  /** latexmk did not run TeX because the previous run had failed. */
  refused: boolean;
  errors: string[];
  logTail: string;
}

/** One engine run over a source tree; the caller decides what a failure means. */
async function runEngine(
  engine: Engine,
  sourceDir: string,
  outDir: string,
  main: string,
  program: TexProgram,
  force: boolean,
): Promise<Attempt> {
  // An incremental latexmk run needs its previous log; every other run starts
  // clean, so a previous attempt's log is never read back as this one's errors.
  const incremental = engine.name === "latexmk" && !force;
  if (!incremental) {
    for (const f of logsIn(outDir)) rmSync(join(outDir, f), { force: true });
  }

  const started = Date.now();
  let combined = "";
  let ok = true;
  try {
    const { stdout, stderr } = await spawnEngine(engine.path, engineArgs(engine.name, outDir, main, program, force), {
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
  const engineOutput = combined;

  // Include the .log file if the engine wrote one — that's where TeX errors live.
  for (const f of logsIn(outDir)) {
    try {
      const path = join(outDir, f);
      // A log latexmk left from an earlier run says nothing about this one.
      if (incremental && statSync(path).mtimeMs < started - 1) continue;
      combined += "\n" + readFileSync(path, "utf8");
    } catch {
      /* no log */
    }
  }

  const built = ok && existsSync(pdfPathFor(outDir, main));
  const errors = built ? [] : parseErrors(combined);
  const refused = !built && incremental && /previous invocation|nothing to do/i.test(engineOutput);
  // Judge the retry on what TeX itself said: the placeholder below is added
  // for the user's benefit and would otherwise read like a document error.
  const retryable = !built && isEngineSpecificFailure(errors);
  if (!built && errors.length === 0) {
    errors.push(`Compilation failed (${engine.name}) — see log tail for details.`);
  }

  return { ok: built, retryable, refused, errors, logTail: combined.split("\n").slice(-60).join("\n") };
}

/**
 * Run the installed engines on a source tree, best first, PDF and logs into
 * outDir. A failure that looks engine-specific (see isEngineSpecificFailure)
 * drops through to the next engine; a broken document stops at the first one.
 * A document without a declared program whose errors ask for XeTeX or LuaTeX
 * (fontspec, unicode-math) is retried once with that program.
 */
async function compileTree(
  sourceDir: string,
  outDir: string,
  mainTex?: string,
  overleafCompiler?: string,
): Promise<CompileResult> {
  const started = Date.now();
  const main = mainTex ?? findMainTex(sourceDir);
  if (!main) {
    return {
      ok: false, engine: "none", mainTex: "", errors: ["No .tex file with \\documentclass found in the project."],
      logTail: "", durationMs: Date.now() - started,
    };
  }
  let { program, source } = resolveTexProgram(sourceDir, main, overleafCompiler);
  const preferred = loadSettings().engine || undefined;
  const installed = async (p: TexProgram) =>
    (await Promise.all(compileOrder(p, preferred).map(resolveEngine))).filter((e): e is Engine => e !== null);
  let engines = await installed(program);
  if (engines.length === 0) {
    return {
      ok: false, engine: "none", mainTex: main,
      errors: ["No LaTeX engine found. Install a TeX distribution (latexmk/pdflatex) or tectonic."],
      logTail: "", durationMs: Date.now() - started, program, programSource: source,
    };
  }

  mkdirSync(outDir, { recursive: true });

  const tried: { engine: string; errors: string[]; logTail: string }[] = [];
  let switched = false;
  /** The attempts the failure report leads with: those for the final program. */
  let reportFrom = 0;
  for (let i = 0; i < engines.length; i++) {
    const engine = engines[i];
    let attempt = await runEngine(engine, sourceDir, outDir, main, program, false);
    if (attempt.refused) attempt = await runEngine(engine, sourceDir, outDir, main, program, true);
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
        program,
        programSource: source,
      };
    }
    tried.push({ engine: engine.name, ...attempt });
    const needed = source === "default" && !switched ? requiredProgram(attempt.errors) : undefined;
    if (needed) {
      // The document asks for another program: start over with its engines.
      switched = true;
      program = needed;
      source = "log";
      engines = await installed(program);
      reportFrom = tried.length;
      i = -1;
      continue;
    }
    if (!attempt.retryable) break;
  }

  // Nothing built it: lead with the first engine's verdict — that is the one
  // the user asked for — and keep every log for the details view. A stale PDF
  // from an earlier build stays addressable so the viewer can keep showing it.
  const [first, ...rest] = reportFrom < tried.length ? tried.slice(reportFrom) : tried;
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
    program,
    programSource: source,
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
  const result = await compileTree(treeDir, revDir, main, overleafCompilerOf(projectId));
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
