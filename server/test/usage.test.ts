import { describe, expect, it } from "vitest";
import { scanCiteUsage, usageReport } from "../src/usage.js";

describe("scanCiteUsage", () => {
  it("counts plain \\cite commands per key per file", () => {
    const usage = scanCiteUsage([
      { file: "main.tex", content: "As shown \\cite{lecun2015deep} and again \\cite{lecun2015deep}." },
      { file: "intro.tex", content: "Also \\cite{lecun2015deep}." },
    ]);
    expect(usage["lecun2015deep"]).toEqual([
      { file: "main.tex", count: 2, lines: [1, 1] },
      { file: "intro.tex", count: 1, lines: [1] },
    ]);
  });

  it("records a 1-indexed line per occurrence, multi-key commands counting for each key", () => {
    const usage = scanCiteUsage([
      {
        file: "main.tex",
        content: "intro text\n\\cite{a} and \\cite{b,a}\nplain line\n\\citep{a}\n",
      },
    ]);
    expect(usage["a"]).toEqual([{ file: "main.tex", count: 3, lines: [2, 2, 4] }]);
    expect(usage["b"]).toEqual([{ file: "main.tex", count: 1, lines: [2] }]);
  });

  it("attributes a multi-line cite argument to the command's starting line", () => {
    const usage = scanCiteUsage([
      { file: "t.tex", content: "line one\n\\cite{a,\n  b}\n" },
    ]);
    expect(usage["a"]).toEqual([{ file: "t.tex", count: 1, lines: [2] }]);
    expect(usage["b"]).toEqual([{ file: "t.tex", count: 1, lines: [2] }]);
  });

  it("splits multi-key citations", () => {
    const usage = scanCiteUsage([
      { file: "main.tex", content: "\\cite{a, b,c}" },
    ]);
    expect(Object.keys(usage).sort()).toEqual(["a", "b", "c"]);
  });

  it("handles optional-arg and starred forms", () => {
    const usage = scanCiteUsage([
      {
        file: "main.tex",
        content:
          "\\cite[p.~5]{key1,key2} \\citep[see][p. 12]{key3} \\citet*{key4} \\cite*[cf.]{key5}",
      },
    ]);
    expect(Object.keys(usage).sort()).toEqual(["key1", "key2", "key3", "key4", "key5"]);
  });

  it("matches the whole cite-command family", () => {
    const content =
      "\\citep{a} \\citet{b} \\citealp{c} \\autocite{d} \\parencite{e} \\textcite{f} \\footcite{g} \\nocite{h}";
    const usage = scanCiteUsage([{ file: "t.tex", content }]);
    expect(Object.keys(usage).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("ignores \\nocite{*} and non-cite commands with cite-ish names", () => {
    const usage = scanCiteUsage([
      { file: "t.tex", content: "\\nocite{*} \\citation{nope} \\textcites{alsonope}" },
    ]);
    expect(usage).toEqual({});
  });

  it("skips commented-out citations but keeps escaped percent signs", () => {
    const usage = scanCiteUsage([
      {
        file: "t.tex",
        content: "real \\cite{kept} % \\cite{commented}\n5\\% growth \\cite{alsokept}",
      },
    ]);
    expect(Object.keys(usage).sort()).toEqual(["alsokept", "kept"]);
  });
});

describe("usageReport", () => {
  it("reports unused and undefined keys", () => {
    const usage = scanCiteUsage([
      { file: "main.tex", content: "\\cite{used} \\cite{ghost}" },
      { file: "ch2.tex", content: "\\citep{ghost}" },
    ]);
    const report = usageReport(["used", "neverCited"], usage);
    expect(report.unusedKeys).toEqual(["neverCited"]);
    expect(report.undefinedKeys).toEqual([{ key: "ghost", files: ["main.tex", "ch2.tex"] }]);
  });

  it("is empty when everything lines up", () => {
    const usage = scanCiteUsage([{ file: "main.tex", content: "\\cite{a}" }]);
    expect(usageReport(["a"], usage)).toEqual({ unusedKeys: [], undefinedKeys: [] });
  });
});
