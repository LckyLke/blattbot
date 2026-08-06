import { describe, expect, it } from "vitest";
import { ENGINE_PRIORITY, engineOrder, isEngineSpecificFailure, parseErrors } from "../src/compile.js";

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
