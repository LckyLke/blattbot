import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

/** Recursively list files under dir, skipping dot-directories and common junk. */
export function listFiles(root: string, subdir = ""): string[] {
  const out: string[] = [];
  const full = join(root, subdir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules") continue;
    // Always "/"-separated: these are protocol paths (Overleaf, git, scope),
    // not OS paths — join() would leak backslashes on Windows.
    const rel = subdir ? `${subdir}/${name}` : name;
    let st;
    try { st = lstatSync(join(root, rel)); } catch { continue; }
    // A symlink can escape the mirror or create an infinite traversal loop.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Find the main .tex file of a project: a file containing \documentclass,
 * preferring top-level files, then names like main.tex.
 */
export function findMainTex(root: string): string | undefined {
  const candidates = listFiles(root).filter((f) => f.endsWith(".tex"));
  const withDocclass: string[] = [];
  for (const rel of candidates) {
    try {
      const head = readFileSync(join(root, rel), "utf8").slice(0, 4000);
      if (/^[^%\n]*\\documentclass/m.test(head)) withDocclass.push(rel);
    } catch {
      /* unreadable file — skip */
    }
  }
  if (withDocclass.length === 0) return candidates[0];
  const score = (f: string): number => {
    let s = 0;
    if (!f.includes("/")) s += 10;
    const base = f.split("/").pop()!.toLowerCase();
    if (base === "main.tex") s += 5;
    if (["thesis.tex", "paper.tex", "report.tex", "article.tex"].includes(base)) s += 3;
    s -= f.split("/").length;
    return s;
  };
  withDocclass.sort((a, b) => score(b) - score(a));
  return withDocclass[0];
}

export function findBibFiles(root: string): string[] {
  return listFiles(root).filter((f) => f.endsWith(".bib"));
}

export interface LabelInfo {
  name: string;
  file: string;
  /** 1-indexed line of the \label command. */
  line: number;
}

/** Text up to the first unescaped % (an odd number of preceding \ escapes it). */
function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

/**
 * Scan all .tex files under root for \label{...} definitions (the targets of
 * \ref/\eqref/\autoref/\cref). Handles multiple labels per line and ignores
 * anything after an unescaped % comment.
 */
export function scanLabels(root: string): LabelInfo[] {
  const out: LabelInfo[] = [];
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (const file of listFiles(root).filter((f) => f.endsWith(".tex"))) {
    let content: string;
    try {
      content = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const code = stripTexComment(lines[i]);
      for (const m of code.matchAll(re)) out.push({ name: m[1].trim(), file, line: i + 1 });
    }
  }
  return out;
}

export { relative };
