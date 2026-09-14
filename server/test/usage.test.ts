import { describe, expect, it } from "vitest";
import { claimContextAtLine, scanCitationLocations, scanCiteUsage, usageReport } from "../src/usage.js";

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
      { file: "t.tex", content: "\\nocite{*} \\citation{nope} \\textcitesExtra{alsonope}" },
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

describe("claimContextAtLine", () => {
  it("returns the whole paragraph (blank-line delimited), not just the one line", () => {
    const tex = [
      "Intro paragraph, unrelated.",
      "",
      "Transformers scale well to long sequences \\cite{vaswani2017}",
      "and outperform recurrent models on translation.",
      "",
      "Trailing paragraph, also unrelated.",
    ].join("\n");
    expect(claimContextAtLine(tex, 3)).toBe(
      "Transformers scale well to long sequences \\cite{vaswani2017} and outperform recurrent models on translation.",
    );
  });

  it("strips comments before extracting", () => {
    const tex = "Real claim \\cite{a} here. % a stray comment\nmore text";
    expect(claimContextAtLine(tex, 1)).toBe("Real claim \\cite{a} here. more text");
  });

  it("clamps an out-of-range line instead of throwing", () => {
    const tex = "only one line";
    expect(claimContextAtLine(tex, 999)).toBe("only one line");
    expect(claimContextAtLine(tex, 0)).toBe("only one line");
  });

  it("truncates a paragraph that runs past the cap", () => {
    const huge = "x".repeat(2000);
    const result = claimContextAtLine(huge, 1);
    expect(result.length).toBe(1501); // 1500 chars + the ellipsis
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("extended citation families", () => {
  it("tracks uppercase natbib commands, biblatex multicites, and author/year citations", () => {
    const usage = scanCiteUsage([{ file: "main.tex", content: String.raw`\Citep[see][p. 2]{Alpha,beta} \parencites{gamma}[p. 3]{delta}{epsilon} \citeauthor{author} \citeyear{year}` }]);
    expect(Object.keys(usage)).toEqual(["Alpha", "beta", "gamma", "delta", "epsilon", "author", "year"]);
  });
  it("does not count citation examples inside verbatim or commented environments", () => {
    const usage = scanCiteUsage([{ file: "main.tex", content: String.raw`\verb|\cite{example}| \begin{verbatim}\cite{example2}\end{verbatim} \cite{real}` }]);
    expect(Object.keys(usage)).toEqual(["real"]);
  });
});

describe("manuscript citation locations", () => {
  it("preserves exact locations, aliases and bibliography-only commands without counting examples", () => {
    const content = String.raw`% \cite{a}
\section{Related work}
We build on \parencites[see]{a}[p. 4]{b} and \cite{a}.
\begin{verbatim}
\cite{a}
\end{verbatim}
\nocite{a}
\verb|\cite{a}|`;
    const locations = scanCitationLocations([{ file: "chapters/related.tex", content },
      { file: "main.tex", content: String.raw`\cite{b}` }], ["a", "b"]);
    expect(locations.map(({ key, file, line, column, kind }) => ({ key, file, line, column, kind }))).toEqual([
      { key: "a", file: "chapters/related.tex", line: 3, column: 13, kind: "citation" },
      { key: "b", file: "chapters/related.tex", line: 3, column: 13, kind: "citation" },
      { key: "a", file: "chapters/related.tex", line: 3, column: 46, kind: "citation" },
      { key: "a", file: "chapters/related.tex", line: 7, column: 1, kind: "bibliography" },
      { key: "b", file: "main.tex", line: 1, column: 1, kind: "citation" },
    ]);
    expect(locations[0].excerpt).toContain("We build on");
    expect(scanCitationLocations([{ file: "main.tex", content }], ["missing"])).toEqual([]);
  });
});
