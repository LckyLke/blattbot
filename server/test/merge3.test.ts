/**
 * The Source editor's three-way merge (web/src/merge3.ts): a draft (ours)
 * typed over `base` while the disk moved to `theirs`.
 */
import { describe, expect, it } from "vitest";
import { diffHunks, merge3 } from "../../web/src/merge3.js";

const L = (...lines: string[]) => lines.join("\n") + "\n";

describe("diffHunks", () => {
  it("returns no hunks for identical inputs", () => {
    expect(diffHunks(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("finds a replacement, an insertion, and a deletion in base coordinates", () => {
    expect(diffHunks(["a", "b", "c"], ["a", "B", "c"])).toEqual([{ start: 1, end: 2, lines: ["B"] }]);
    expect(diffHunks(["a", "c"], ["a", "b", "c"])).toEqual([{ start: 1, end: 1, lines: ["b"] }]);
    expect(diffHunks(["a", "b", "c"], ["a", "c"])).toEqual([{ start: 1, end: 2, lines: [] }]);
  });

  it("handles edits at both ends", () => {
    expect(diffHunks(["x", "a", "b"], ["a", "b", "y"])).toEqual([
      { start: 0, end: 1, lines: [] },
      { start: 3, end: 3, lines: ["y"] },
    ]);
  });
});

describe("merge3", () => {
  const base = L("\\section{Intro}", "Attention is useful.", "", "\\section{Methods}", "We study f.");

  it("takes the disk version when the draft is clean, and the draft when the disk did not move", () => {
    const theirs = base.replace("useful", "central");
    expect(merge3(base, base, theirs)).toEqual({ text: theirs, conflicts: 0 });
    const ours = base.replace("We study f.", "We study f and g.");
    expect(merge3(base, ours, base)).toEqual({ text: ours, conflicts: 0 });
  });

  it("merges edits in different regions without conflict", () => {
    const ours = base.replace("We study f.", "We study f and g.");
    const theirs = base.replace("useful", "central");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(0);
    expect(r.text).toBe(L("\\section{Intro}", "Attention is central.", "", "\\section{Methods}", "We study f and g."));
  });

  it("takes an identical change once", () => {
    const both = base.replace("useful", "central");
    expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
  });

  it("marks a region both sides changed differently as one conflict block", () => {
    const ours = base.replace("Attention is useful.", "Attention is central.");
    const theirs = base.replace("Attention is useful.", "Attention is everything.");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(
      L(
        "\\section{Intro}",
        "<<<<<<< yours",
        "Attention is central.",
        "=======",
        "Attention is everything.",
        ">>>>>>> disk",
        "",
        "\\section{Methods}",
        "We study f.",
      ),
    );
  });

  it("treats a modification against a deletion as a conflict", () => {
    const ours = base.replace("We study f.", "We study f carefully.");
    const theirs = L("\\section{Intro}", "Attention is useful.", "", "\\section{Methods}");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("<<<<<<< yours\nWe study f carefully.\n=======\n>>>>>>> disk");
  });

  it("merges an insertion on one side with a change elsewhere on the other", () => {
    const ours = L("\\section{Intro}", "Attention is useful.", "It scales.", "", "\\section{Methods}", "We study f.");
    const theirs = base.replace("We study f.", "We study g.");
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(0);
    expect(r.text).toBe(L("\\section{Intro}", "Attention is useful.", "It scales.", "", "\\section{Methods}", "We study g."));
  });

  it("keeps the draft's trailing-newline choice and handles empty inputs", () => {
    expect(merge3("", "a\n", "")).toEqual({ text: "a\n", conflicts: 0 });
    expect(merge3("", "", "b\n")).toEqual({ text: "b\n", conflicts: 0 });
    const noNl = merge3("a\nb\n", "a\nb\nc", "A\nb\n");
    expect(noNl.conflicts).toBe(0);
    expect(noNl.text).toBe("A\nb\nc");
  });

  it("stays bounded on large unrelated inputs", () => {
    const b = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const o = b.replace("line 10", "line ten");
    const t = b.replace("line 2900", "line twenty-nine-hundred");
    const r = merge3(b, o, t);
    expect(r.conflicts).toBe(0);
    expect(r.text).toContain("line ten");
    expect(r.text).toContain("line twenty-nine-hundred");
  });
});
