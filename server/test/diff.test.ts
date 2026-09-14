import { passageRange } from "../../web/src/diff.js";
import { describe, expect, it } from "vitest";
import { buildHunkPatch, parseDiff } from "../../web/src/diff.js";

const SAMPLE = `diff --git a/main.tex b/main.tex
index 1234567..89abcde 100644
--- a/main.tex
+++ b/main.tex
@@ -1,4 +1,5 @@ \\section{Intro}
 \\documentclass{article}
-\\title{Old Title}
+\\title{New Title}
+\\author{BlattBot}
 \\begin{document}
diff --git a/references.bib b/references.bib
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/references.bib
@@ -0,0 +1,2 @@
+@article{key, title={T},
+}
`;

describe("parseDiff", () => {
  it("splits files and counts additions/deletions", () => {
    const files = parseDiff(SAMPLE);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("main.tex");
    expect(files[0].status).toBe("modified");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].path).toBe("references.bib");
    expect(files[1].status).toBe("added");
    expect(files[1].additions).toBe(2);
  });

  it("tracks line numbers through hunks", () => {
    const files = parseDiff(SAMPLE);
    const lines = files[0].hunks[0].lines;
    const del = lines.find((l) => l.kind === "del");
    const adds = lines.filter((l) => l.kind === "add");
    expect(del?.oldNo).toBe(2);
    expect(adds[0]?.newNo).toBe(2);
    expect(adds[1]?.newNo).toBe(3);
    // context after the change continues both counters
    const trailing = lines[lines.length - 1];
    expect(trailing.kind).toBe("ctx");
    expect(trailing.oldNo).toBe(3);
    expect(trailing.newNo).toBe(4);
  });

  it("captures the hunk section header", () => {
    const files = parseDiff(SAMPLE);
    expect(files[0].hunks[0].header).toContain("\\section{Intro}");
  });

  it("returns empty for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("   \n")).toEqual([]);
  });

  it("retains the raw hunk header and body lines", () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    expect(hunk.rawHeader).toBe("@@ -1,4 +1,5 @@ \\section{Intro}");
    expect(hunk.rawLines).toEqual([
      " \\documentclass{article}",
      "-\\title{Old Title}",
      "+\\title{New Title}",
      "+\\author{BlattBot}",
      " \\begin{document}",
    ]);
  });
});

describe("buildHunkPatch", () => {
  it("reconstructs a standalone patch for a modified-file hunk", () => {
    const file = parseDiff(SAMPLE)[0];
    expect(buildHunkPatch(file, file.hunks[0])).toBe(
      `diff --git a/main.tex b/main.tex
--- a/main.tex
+++ b/main.tex
@@ -1,4 +1,5 @@ \\section{Intro}
 \\documentclass{article}
-\\title{Old Title}
+\\title{New Title}
+\\author{BlattBot}
 \\begin{document}
`,
    );
  });

  it("uses /dev/null for new files", () => {
    const file = parseDiff(SAMPLE)[1];
    const patch = buildHunkPatch(file, file.hunks[0]);
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/references.bib");
    expect(patch.endsWith("+}\n")).toBe(true);
  });
});


describe("inline added passage ranges", () => {
  it("preserves surrounding lines and the final newline", () => {
    const source = "before\nnew one\nnew two\nafter\n";
    const range = passageRange(source, [
      { kind: "add", text: "new one", newNo: 2 },
      { kind: "add", text: "new two", newNo: 3 },
    ]);
    expect(source.slice(0, range.start) + "replacement" + source.slice(range.end)).toBe("before\nreplacement\nafter\n");
  });
  it("supports a new file without a final newline and empty added lines", () => {
    expect(passageRange("new", [{ kind: "add", text: "new", newNo: 1 }])).toEqual({ start: 0, end: 3, text: "new" });
    expect(passageRange("before\n\nafter", [{ kind: "add", text: "", newNo: 2 }])).toEqual({ start: 7, end: 7, text: "" });
  });
  it("rejects stale passages instead of editing the wrong lines", () => {
    expect(() => passageRange("before\nchanged", [{ kind: "add", text: "old", newNo: 2 }])).toThrow("changed");
  });
});
