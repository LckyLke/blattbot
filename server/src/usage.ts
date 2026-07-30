/**
 * Citation-usage tracking: scan .tex sources for \cite-family commands and
 * reconcile the cited keys against the bibliography.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./latex.js";

/** Where (and how often) a key is cited. */
export interface UsageSite {
  file: string;
  count: number;
  /** 1-indexed line of each citing command, one per occurrence (parallel to count). */
  lines: number[];
}

export type CiteUsage = Record<string, UsageSite[]>;

// Longest names first so the regex alternation never stops at a prefix.
const CITE_COMMANDS = [
  "autocite",
  "parencite",
  "textcite",
  "footcite",
  "citealp",
  "citep",
  "citet",
  "nocite",
  "cite",
];

// \cite[p.~5]{a,b} — starred forms and up to two optional args (natbib pre/post notes).
const CITE_RE = new RegExp(
  `\\\\(?:${CITE_COMMANDS.join("|")})\\*?(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^{}]*)\\}`,
  "g",
);

/** Drop LaTeX comments: everything from an unescaped % to the end of the line. */
function stripComments(tex: string): string {
  return tex
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * Scan .tex sources for citation commands (\cite, \citep, \citet, \citealp,
 * \autocite, \parencite, \textcite, \footcite, \nocite — starred and
 * optional-arg forms included) and count citations per key per file.
 * Pure: takes file contents, returns key → [{file, count, lines}].
 */
export function scanCiteUsage(files: { file: string; content: string }[]): CiteUsage {
  const usage: CiteUsage = {};
  for (const { file, content } of files) {
    const text = stripComments(content);
    // Matches arrive in document order, so line lookup can walk forward once.
    let scanPos = 0;
    let scanLine = 1;
    const lineAt = (idx: number) => {
      for (; scanPos < idx; scanPos++) if (text.charCodeAt(scanPos) === 10) scanLine++;
      return scanLine;
    };
    CITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_RE.exec(text)) !== null) {
      const line = lineAt(m.index); // the line the \cite command starts on
      for (const rawKey of m[1].split(",")) {
        const key = rawKey.trim();
        if (!key || key === "*") continue; // \nocite{*} is "cite everything", not a key
        const sites = (usage[key] ??= []);
        const site = sites.find((s) => s.file === file);
        if (site) {
          site.count++;
          site.lines.push(line);
        } else {
          sites.push({ file, count: 1, lines: [line] });
        }
      }
    }
  }
  return usage;
}

export interface UsageReport {
  /** Keys present in the bibliography but never cited. */
  unusedKeys: string[];
  /** Keys cited in .tex files but defined in no .bib file. */
  undefinedKeys: { key: string; files: string[] }[];
}

/** Reconcile bibliography keys against scanned usage. Pure. */
export function usageReport(bibKeys: string[], usage: CiteUsage): UsageReport {
  const defined = new Set(bibKeys);
  const unusedKeys = bibKeys.filter((k) => !usage[k]);
  const undefinedKeys = Object.entries(usage)
    .filter(([key]) => !defined.has(key))
    .map(([key, sites]) => ({ key, files: sites.map((s) => s.file) }));
  return { unusedKeys, undefinedKeys };
}

/** Scan every .tex file in a project directory. */
export function collectCiteUsage(projectPath: string): CiteUsage {
  const texFiles = listFiles(projectPath).filter((f) => f.endsWith(".tex"));
  const inputs: { file: string; content: string }[] = [];
  for (const file of texFiles) {
    try {
      inputs.push({ file, content: readFileSync(join(projectPath, file), "utf8") });
    } catch {
      /* unreadable file — skip */
    }
  }
  return scanCiteUsage(inputs);
}
