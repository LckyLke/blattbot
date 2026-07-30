import { describe, expect, it } from "vitest";
import { locateInSources, tokenize } from "../src/locate.js";

const MAIN = `\\documentclass{article}
\\title{A Study of Attention}
\\begin{document}
\\maketitle
\\section{Introduction}
% this comment mentions transformers and attention but must not match
Attention mechanisms let a model \\emph{weigh} context
dynamically~\\cite{vaswani2017attention}, which improves long-range
dependency handling in practice.
\\section{Methods}
We evaluate on three standard benchmarks under identical conditions.
\\end{document}
`;

describe("tokenize", () => {
  it("strips LaTeX commands but keeps their argument text with line numbers", () => {
    const tokens = tokenize("\\section{Introduction}\nplain prose here");
    expect(tokens.map((t) => t.key)).toEqual(["introduction", "plain", "prose", "here"]);
    expect(tokens[0].line).toBe(1);
    expect(tokens[1].line).toBe(2);
  });

  it("rejoins hyphenation across line breaks onto the first fragment's line", () => {
    const tokens = tokenize("a tricky exam-\nple of hyphenation");
    const keys = tokens.map((t) => t.key);
    expect(keys).toContain("example");
    expect(tokens.find((t) => t.key === "example")!.line).toBe(1);
  });

  it("expands ligatures and drops soft hyphens", () => {
    const tokens = tokenize("an ef\u00ADficient \uFB01nding of arti\uFB01cial \uFB02uency");
    expect(tokens.map((t) => t.key)).toEqual(["an", "efficient", "finding", "of", "artificial", "fluency"]);
  });

  it("drops comments and punctuation-only tokens", () => {
    const tokens = tokenize("real text % secret comment words\n— ( ) more");
    expect(tokens.map((t) => t.key)).toEqual(["real", "text", "more"]);
  });

  it("keeps escaped specials as part of the word", () => {
    const tokens = tokenize("a 50\\% increase");
    expect(tokens.map((t) => t.key)).toEqual(["a", "50", "increase"]);
  });
});

describe("locateInSources", () => {
  const files = [{ file: "main.tex", content: MAIN }];

  it("finds prose spanning LaTeX commands and returns the starting line", () => {
    const hit = locateInSources("Attention mechanisms let a model weigh context", files);
    expect(hit).not.toBeNull();
    expect(hit!.file).toBe("main.tex");
    expect(hit!.line).toBe(7); // "Attention mechanisms let a model \emph{weigh} context"
    expect(hit!.matched).toBeGreaterThanOrEqual(7);
  });

  it("matches PDF-side hyphenation and ligatures against clean source", () => {
    // The PDF renders "dynamically" broken as "dynam- ically" and no ligature
    // magic is needed for the rest.
    const hit = locateInSources(
      "weigh context dynam- ically which improves long-range dependency handling",
      files,
    );
    expect(hit).not.toBeNull();
    // The \cite key splits the source run; the best run starts at "which" (line 8).
    expect(hit!.line).toBe(8);
    expect(hit!.matched).toBeGreaterThanOrEqual(5);
  });

  it("matches source-side hyphenation across lines", () => {
    const src = [{ file: "h.tex", content: "We present a tricky exam-\nple of hyphenation in sources here" }];
    const hit = locateInSources("a tricky example of hyphenation", src);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(1);
  });

  it("returns the later line when the match starts mid-file", () => {
    const hit = locateInSources("We evaluate on three standard benchmarks under identical conditions", files);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(11);
  });

  it("does not match words that only appear in comments", () => {
    const hit = locateInSources("this comment mentions transformers and attention but", files);
    // Only fragmented overlaps exist outside the comment — no ≥4-word run.
    expect(hit).toBeNull();
  });

  it("rejects queries without a sufficient consecutive run", () => {
    expect(locateInSources("purple monkey dishwasher quantum zebra falafel", files)).toBeNull();
  });

  it("accepts short queries via the 60% rule", () => {
    const hit = locateInSources("standard benchmarks", files);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(11);
  });

  it("is case- and punctuation-insensitive", () => {
    const hit = locateInSources("DEPENDENCY handling, in practice!", files);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(9); // "dependency handling in practice." starts line 9
  });

  it("picks the best-scoring file among several", () => {
    const multi = [
      { file: "a.tex", content: "attention mechanisms are neat" },
      ...files,
    ];
    const hit = locateInSources("Attention mechanisms let a model weigh context", multi);
    expect(hit!.file).toBe("main.tex");
  });

  it("returns null for empty or symbol-only queries", () => {
    expect(locateInSources("", files)).toBeNull();
    expect(locateInSources("~ $ % {}", files)).toBeNull();
  });
});
