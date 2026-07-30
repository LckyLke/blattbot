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
