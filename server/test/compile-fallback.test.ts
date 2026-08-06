/**
 * The engine chain: latexmk → pdflatex → tectonic, with fake engines in
 * BIN_DIR so the test is instant and hermetic. Each fake records that it ran,
 * so the assertions are about WHICH engines a failure reaches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let sourceDir: string;
let compile: typeof import("../src/compile.js");

/** A fake engine: appends its name to the run log, then behaves as told. */
function fakeEngine(name: string, body: string): void {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const main = args[args.length - 1];",
    // latexmk/pdflatex take -outdir=/-output-directory=, tectonic takes --outdir <dir>.
    "const flag = args.find((a) => a.startsWith('-outdir=') || a.startsWith('-output-directory='));",
    "const out = flag ? flag.split('=')[1] : args[args.indexOf('--outdir') + 1];",
    "const pdf = path.join(out, path.basename(main, '.tex') + '.pdf');",
    `fs.appendFileSync(${JSON.stringify(join(dataDir, "runlog"))}, ${JSON.stringify(name)} + '\\n');`,
    body,
    "",
  ].join("\n");
  const bin = join(dataDir, "bin");
  if (process.platform === "win32") {
    writeFileSync(join(bin, `${name}.js`), script);
    writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`);
  } else {
    writeFileSync(join(bin, name), `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  }
}

/** Fails the way a TeX run does: a "!" line on stdout and a non-zero exit. */
const failsWith = (texError: string) =>
  `process.stdout.write(${JSON.stringify(texError)} + '\\n'); process.exit(1);`;

const writesPdf = "fs.writeFileSync(pdf, '%PDF-1.4 fake\\n');";

function enginesRun(): string[] {
  const log = join(dataDir, "runlog");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function resetRuns(): void {
  rmSync(join(dataDir, "runlog"), { force: true });
  rmSync(join(dataDir, "builds"), { recursive: true, force: true });
  compile.resetEngineCache();
}

describe("engine fallback chain", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "blattbot-fallback-"));
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    sourceDir = join(dataDir, "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "main.tex"), "\\documentclass{article}\n\\begin{document}hi\\end{document}\n");

    vi.stubEnv("BLATTBOT_DATA_DIR", dataDir);
    vi.resetModules();
    compile = await import("../src/compile.js");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("prefers latexmk and stops there when it builds the document", async () => {
    fakeEngine("latexmk", writesPdf);
    fakeEngine("pdflatex", writesPdf);
    fakeEngine("tectonic", writesPdf);
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("latexmk");
    expect(enginesRun()).toEqual(["latexmk"]);
  });

  it("falls through to tectonic when the local TeX tree lacks a package", async () => {
    fakeEngine("latexmk", failsWith("! LaTeX Error: File `cleanthesis.sty' not found."));
    fakeEngine("pdflatex", failsWith("! LaTeX Error: File `cleanthesis.sty' not found."));
    fakeEngine("tectonic", writesPdf);
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("tectonic");
    expect(enginesRun()).toEqual(["latexmk", "pdflatex", "tectonic"]);
    // The badge says tectonic — the log says why.
    expect(r.logTail).toContain("note: latexmk could not build this document");
  });

  it("falls through when an engine dies without reporting a TeX error", async () => {
    // tectonic exits like this when a biblatex project has no biber on PATH.
    fakeEngine("latexmk", "process.stderr.write('error: No such file or directory\\n'); process.exit(1);");
    fakeEngine("pdflatex", writesPdf);
    fakeEngine("tectonic", writesPdf);
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("pdflatex");
    expect(enginesRun()).toEqual(["latexmk", "pdflatex"]);
  });

  it("stops at the first engine when the document itself is broken", async () => {
    fakeEngine("latexmk", failsWith("! Undefined control sequence."));
    fakeEngine("pdflatex", writesPdf);
    fakeEngine("tectonic", writesPdf);
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(false);
    expect(r.engine).toBe("latexmk");
    expect(r.errors[0]).toContain("Undefined control sequence");
    // Every engine would fail the same way — no point burning two more compiles.
    expect(enginesRun()).toEqual(["latexmk"]);
  });

  it("reports the preferred engine's errors when nothing builds it", async () => {
    fakeEngine("latexmk", failsWith("! LaTeX Error: File `missing.sty' not found."));
    fakeEngine("pdflatex", failsWith("! LaTeX Error: File `missing.sty' not found."));
    fakeEngine("tectonic", failsWith("! Package pdfx Error: CreationDate is not properly supported;"));
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(false);
    expect(r.engine).toBe("latexmk");
    expect(r.errors[0]).toContain("missing.sty");
    expect(r.errors[r.errors.length - 1]).toContain("Also tried pdflatex, tectonic");
    expect(r.logTail).toContain("--- tectonic ---");
    expect(enginesRun()).toEqual(["latexmk", "pdflatex", "tectonic"]);
  });

  it("puts the configured engine first but keeps the others as fallbacks", async () => {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ engine: "tectonic" }));
    fakeEngine("latexmk", writesPdf);
    fakeEngine("pdflatex", writesPdf);
    fakeEngine("tectonic", failsWith("! LaTeX Error: File `missing.sty' not found."));
    resetRuns();

    const r = await compile.compileProject("p", sourceDir, "main.tex");
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("latexmk");
    expect(enginesRun()).toEqual(["tectonic", "latexmk"]);
    rmSync(join(dataDir, "settings.json"), { force: true });
  });
});
