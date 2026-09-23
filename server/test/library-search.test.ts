import { describe, expect, it } from "vitest";
import {
  paperChunks,
  passageWindow,
  searchTerms,
} from "../src/research/library-text.js";

describe("paper content segmentation", () => {
  it("splits a mixed page at References, carries through following pages, and resumes at an appendix", () => {
    const pages = [
      "Results\nThe method fails on unseen graphs.\nReferences\n[1] Someone. A famous method. 2020.",
      "[2] Another reference. 2021.\nAppendix A\nThe complete ablation uses five seeds.",
    ];
    const chunks = paperChunks(pages);
    expect(chunks.map((c) => c.section)).toEqual([
      "body",
      "references",
      "references",
      "appendix",
    ]);
    for (const c of chunks)
      expect(pages[c.page - 1].slice(c.start, c.start + c.text.length)).toBe(
        c.text,
      );
    expect(chunks[0].text).not.toContain("famous");
  });
  it("does not mistake mentions or table-of-contents entries for a bibliography heading", () => {
    const pages = [
      "References to earlier experiments appear below.\nReferences ........ 15\nOur result is negative.",
    ];
    expect(paperChunks(pages).every((c) => c.section === "body")).toBe(true);
  });
  it("supports numbered headings and returns to supplementary content", () => {
    expect(
      paperChunks([
        "6. REFERENCES\nA citation",
        "Supplementary Material\nMore evidence",
      ]).map((c) => c.section),
    ).toEqual(["references", "appendix"]);
  });
  it("ignores common query words while retaining numbers, negation and identifiers", () => {
    expect(
      searchTerms(
        "What is the accuracy on dataset B with no improvement at 91 percent?",
      ),
    ).toEqual([
      "accuracy",
      "dataset",
      "b",
      "no",
      "improvement",
      "91",
      "percent",
    ]);
  });
  it("returns a verbatim window around the relevant passage instead of the chunk's beginning", () => {
    const text =
      "Unrelated background. ".repeat(40) +
      "The unexpected limitation is severe.";
    const result = passageWindow(text, ["limitation"], 200);
    expect(result.text).toContain("limitation");
    expect(text.slice(result.start, result.start + result.text.length)).toBe(
      result.text,
    );
    expect(result.text.length).toBeLessThanOrEqual(200);
  });
});
