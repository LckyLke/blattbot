import { describe, expect, it } from "vitest";
import { parseErrors } from "../src/compile.js";

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
