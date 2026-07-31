import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBibFiles, findMainTex, listFiles, scanLabels } from "../src/latex.js";

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "blattbot-test-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("findMainTex", () => {
  it("prefers a top-level file with \\documentclass", () => {
    const dir = fixture({
      "main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}",
      "chapters/ch1.tex": "\\section{One}",
    });
    expect(findMainTex(dir)).toBe("main.tex");
  });

  it("ignores commented-out \\documentclass", () => {
    const dir = fixture({
      "notes.tex": "% \\documentclass{article}\njust notes",
      "paper.tex": "\\documentclass{acmart}\n\\begin{document}\\end{document}",
    });
    expect(findMainTex(dir)).toBe("paper.tex");
  });

  it("prefers main.tex when several candidates exist", () => {
    const dir = fixture({
      "appendix.tex": "\\documentclass{article}",
      "main.tex": "\\documentclass{article}",
    });
    expect(findMainTex(dir)).toBe("main.tex");
  });

  it("returns undefined for a project with no .tex files", () => {
    const dir = fixture({ "readme.md": "# hi" });
    expect(findMainTex(dir)).toBeUndefined();
  });
});

describe("scanLabels", () => {
  it("collects labels across files with 1-indexed lines", () => {
    const dir = fixture({
      "main.tex": "\\section{Intro}\\label{sec:intro}\nText.\n\\begin{equation}\\label{eq:loss}\nE\n\\end{equation}\n",
      "chapters/ch1.tex": "\\subsection{Setup}\n\\label{sec:setup}\n",
      "notes.md": "\\label{not:tex}",
    });
    expect(scanLabels(dir)).toEqual([
      { name: "sec:setup", file: "chapters/ch1.tex", line: 2 },
      { name: "sec:intro", file: "main.tex", line: 1 },
      { name: "eq:loss", file: "main.tex", line: 3 },
    ]);
  });

  it("finds multiple labels on one line", () => {
    const dir = fixture({
      "main.tex": "\\label{fig:a} middle \\label {fig:b}\n",
    });
    expect(scanLabels(dir).map((l) => l.name)).toEqual(["fig:a", "fig:b"]);
  });

  it("ignores labels after an unescaped %, but not after \\%", () => {
    const dir = fixture({
      "main.tex": [
        "% \\label{sec:commented}",
        "\\label{sec:kept} % \\label{sec:trailing}",
        "100\\% sure \\label{sec:escaped}",
        "\\\\% linebreak then comment \\label{sec:after-linebreak}",
      ].join("\n"),
    });
    expect(scanLabels(dir).map((l) => l.name)).toEqual(["sec:kept", "sec:escaped"]);
  });
});

describe("listFiles / findBibFiles", () => {
  it("lists recursively and skips dotfiles", () => {
    const dir = fixture({
      "a.tex": "x",
      "sub/b.bib": "@article{x, title={T}}",
      ".git/config": "hidden",
    });
    const files = listFiles(dir);
    expect(files).toContain("a.tex");
    expect(files).toContain("sub/b.bib");
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    expect(findBibFiles(dir)).toEqual(["sub/b.bib"]);
  });
});
