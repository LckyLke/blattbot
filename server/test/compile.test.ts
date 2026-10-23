import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_PRIORITY,
  compileOrder,
  engineOrder,
  isEngineSpecificFailure,
  magicProgram,
  parseErrors,
  requiredProgram,
  resolveTexProgram,
} from "../src/compile.js";

describe("parseErrors", () => {
  it("extracts classic TeX bang errors with context", () => {
    const log = [
      "This is pdfTeX",
      "! Undefined control sequence.",
      "l.42 \\badmacro",
      "",
      "some other output",
    ].join("\n");
    const errors = parseErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Undefined control sequence");
    expect(errors[0]).toContain("l.42");
  });

  it("extracts tectonic-style error lines", () => {
    const log = "note: this is fine\nerror: main.tex:10: something broke\nnote: after";
    const errors = parseErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("main.tex:10");
  });

  it("returns empty for a clean log", () => {
    expect(parseErrors("Output written on main.pdf (2 pages).")).toEqual([]);
  });

  it("caps the number of reported errors", () => {
    const log = Array.from({ length: 50 }, (_, i) => `! Error number ${i}.`).join("\n");
    expect(parseErrors(log).length).toBeLessThanOrEqual(20);
  });
});

describe("engineOrder", () => {
  it("prefers a full TeX distribution, tectonic last", () => {
    expect(engineOrder()).toEqual(["latexmk", "pdflatex", "tectonic"]);
  });

  it("puts the configured engine first and keeps the rest as fallbacks", () => {
    expect(engineOrder("tectonic")).toEqual(["tectonic", "latexmk", "pdflatex"]);
    expect(engineOrder("pdflatex")).toEqual(["pdflatex", "latexmk", "tectonic"]);
  });

  it("never lists an engine twice", () => {
    for (const name of ENGINE_PRIORITY) {
      const order = engineOrder(name);
      expect(new Set(order).size).toBe(order.length);
      expect(order).toHaveLength(ENGINE_PRIORITY.length);
    }
  });
});

describe("isEngineSpecificFailure", () => {
  it("retries when the engine died without reporting a TeX error", () => {
    // tectonic on a biblatex project with no biber on PATH.
    expect(isEngineSpecificFailure([])).toBe(true);
  });

  it("retries when the TeX tree is missing a package", () => {
    expect(isEngineSpecificFailure(["! LaTeX Error: File `cleanthesis.sty' not found."])).toBe(true);
  });

  it("retries on an engine capability the document needs", () => {
    expect(
      isEngineSpecificFailure([
        "! Package pdfx Error: CreationDate is not properly supported;\nl.1285 ...",
      ]),
    ).toBe(true);
  });

  it("stops at a broken document — every engine would fail the same way", () => {
    expect(isEngineSpecificFailure(["! Undefined control sequence.\nl.42 \\badmacro"])).toBe(false);
    expect(isEngineSpecificFailure(["! Missing $ inserted."])).toBe(false);
  });

  it("does not retry over a missing figure", () => {
    expect(isEngineSpecificFailure(["! LaTeX Error: File `gfx/plot.png' not found."])).toBe(false);
  });
});

// Real log output of the packages that need XeTeX or LuaTeX, as pdfLaTeX prints it.
const FONTSPEC_LOG = [
  "(/usr/share/texlive/texmf-dist/tex/latex/fontspec/fontspec.sty",
  "",
  "! Fatal Package fontspec Error: The fontspec package requires either XeTeX or",
  "(fontspec)                      LuaTeX.",
  "(fontspec)                      ",
  "(fontspec)                      You must change your typesetting engine to,",
  '(fontspec)                      e.g., "xelatex" or "lualatex" instead of',
  '(fontspec)                      "latex" or "pdflatex".',
  "",
  "Type <return> to continue.",
  " ...                                              ",
  "                                                  ",
  "l.101 \\msg_fatal:nn {fontspec} {cannot-use-pdftex}",
].join("\n");

describe("engine requirements in the log", () => {
  it("retries fontspec's 'requires either XeTeX or LuaTeX' with XeLaTeX", () => {
    const errors = parseErrors(FONTSPEC_LOG);
    expect(errors[0]).toContain("requires either XeTeX or");
    expect(isEngineSpecificFailure(errors)).toBe(true);
    expect(requiredProgram(errors)).toBe("xelatex");
  });

  it("recognizes the other wordings", () => {
    expect(requiredProgram(["! Fatal Package unicode-math Error: Cannot be run with pdfLaTeX!"])).toBe("xelatex");
    expect(requiredProgram(["! Package luacode Error: LuaTeX is required for this package. Aborting."])).toBe("lualatex");
    expect(requiredProgram(["! Package polyglossia Error: This package must be run with XeLaTeX or LuaLaTeX."])).toBe("xelatex");
    expect(requiredProgram(["! Package fontspec Error: requires xelatex"])).toBe("xelatex");
    expect(isEngineSpecificFailure(["! Fatal Package unicode-math Error: Cannot be run with pdfLaTeX!"])).toBe(true);
    expect(requiredProgram(["! Undefined control sequence."])).toBeUndefined();
  });
});

describe("TeX program per project", () => {
  it("reads % !TEX program magic comments", () => {
    expect(magicProgram("% !TEX program = xelatex\n\\documentclass{article}")).toBe("xelatex");
    expect(magicProgram("%!TeX TS-program = LuaLaTeX\n")).toBe("lualatex");
    expect(magicProgram("% !TEX program=pdflatex")).toBe("pdflatex");
    expect(magicProgram("\\documentclass{article}\n% just a comment")).toBeUndefined();
    expect(magicProgram("% !TEX program = context")).toBeUndefined();
  });

  it("prefers the magic comment, then the Overleaf compiler, then pdflatex", () => {
    const dir = mkdtempSync(join(tmpdir(), "blattbot-program-"));
    try {
      writeFileSync(join(dir, "main.tex"), "% !TEX program = lualatex\n\\documentclass{article}\n");
      writeFileSync(join(dir, "plain.tex"), "\\documentclass{article}\n");
      expect(resolveTexProgram(dir, "main.tex", "xelatex")).toEqual({ program: "lualatex", source: "magic comment" });
      expect(resolveTexProgram(dir, "plain.tex", "xelatex")).toEqual({ program: "xelatex", source: "Overleaf" });
      expect(resolveTexProgram(dir, "plain.tex", "latex")).toEqual({ program: "latex", source: "Overleaf" });
      expect(resolveTexProgram(dir, "plain.tex", undefined)).toEqual({ program: "pdflatex", source: "default" });
      expect(resolveTexProgram(dir, "plain.tex", "nonsense")).toEqual({ program: "pdflatex", source: "default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders the engines for the program", () => {
    expect(compileOrder("pdflatex")).toEqual(["latexmk", "pdflatex", "tectonic"]);
    expect(compileOrder("xelatex")).toEqual(["latexmk", "xelatex", "tectonic"]);
    // The "pdflatex" setting means: run the document's program directly.
    expect(compileOrder("xelatex", "pdflatex")).toEqual(["xelatex", "latexmk", "tectonic"]);
    expect(compileOrder("xelatex", "tectonic")).toEqual(["tectonic", "latexmk", "xelatex"]);
    // tectonic is XeTeX-based: never first for a LuaLaTeX document.
    expect(compileOrder("lualatex", "tectonic")).toEqual(["latexmk", "lualatex", "tectonic"]);
    expect(compileOrder("latex")).toEqual(["latexmk", "tectonic"]);
  });
});
