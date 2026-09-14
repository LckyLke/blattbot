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
  "autocites",
  "parencites",
  "textcites",
  "footcites",
  "smartcites",
  "supercites",
  "cites",
  "autocite",
  "parencite",
  "textcite",
  "footcite",
  "smartcite",
  "supercite",
  "footfullcite",
  "fullcite",
  "citeyearpar",
  "citeauthor",
  "citeyear",
  "citetitle",
  "citealp",
  "citealt",
  "citep",
  "citet",
  "nocite",
  "cite",
];

// \cite[p.~5]{a,b} — starred forms and up to two optional args (natbib pre/post notes).
const CITE_RE = new RegExp(
  `\\\\(${CITE_COMMANDS.join("|")})\\*?(?:\\s*\\[[^\\]]*\\]){0,2}\\s*\\{([^{}]*)\\}`,
  "gi",
);

/** Drop LaTeX comments: everything from an unescaped % to the end of the line. */
export function stripComments(tex: string): string {
  return tex
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%") {
          let slashes = 0;
          for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
          if (slashes % 2 === 0) return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

export interface CitationLocation {
  key: string;
  file: string;
  line: number;
  column: number;
  kind: "citation" | "bibliography";
  excerpt: string;
}

/** Preserve exact command locations, including separate citations on one line. */
export function scanCitationLocations(
  files: { file: string; content: string }[],
  keys?: string[],
  withExcerpts = true,
): CitationLocation[] {
  const locations: CitationLocation[] = [];
  const wanted = keys ? new Set(keys) : undefined;
  for (const { file, content } of files) {
    const clean = stripComments(content);
    const sourceLines = clean.split("\n");
    const blank = (value: string) => value.replace(/[^\n]/g, " ");
    const text = clean
      .replace(
        /\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g,
        blank,
      )
      .replace(/\\verb\*?([^\w\s])[^\n]*?\1/g, blank);
    // Matches arrive in document order, so line lookup can walk forward once.
    let scanPos = 0;
    let scanLine = 1;
    const lineAt = (idx: number) => {
      for (; scanPos < idx; scanPos++)
        if (text.charCodeAt(scanPos) === 10) scanLine++;
      return scanLine;
    };
    CITE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_RE.exec(text)) !== null) {
      const line = lineAt(m.index); // the line the \cite command starts on
      const groups = [m[2]];
      if (m[1].toLowerCase().endsWith("s")) {
        let tail: RegExpExecArray | null;
        while (
          (tail = /^(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]*)\}/.exec(
            text.slice(CITE_RE.lastIndex),
          ))
        ) {
          groups.push(tail[1]);
          CITE_RE.lastIndex += tail[0].length;
        }
      }
      for (const rawKey of groups.flatMap((group) => group.split(","))) {
        const key = rawKey.trim();
        if (!key || key === "*") continue; // \nocite{*} is "cite everything", not a key
        if (wanted && !wanted.has(key)) continue;
        const column = m.index - text.lastIndexOf("\n", m.index - 1);
        // Keep the cited command in view even in very long LaTeX paragraphs.
        const sourceLine = sourceLines[line - 1] ?? "";
        const start = Math.max(0, column - 1 - 180);
        const paragraph = withExcerpts
          ? claimContextAtLine(content, line, 600)
          : "";
        const excerpt = !withExcerpts
          ? ""
          : sourceLine.length > 600
            ? `${start ? "…" : ""}${sourceLine.slice(start, start + 600)}${sourceLine.length > start + 600 ? "…" : ""}`
            : paragraph.endsWith("…")
              ? sourceLines
                  .slice(line - 1, line + 2)
                  .join(" ")
                  .slice(0, 600)
              : paragraph;
        locations.push({
          key,
          file,
          line,
          column,
          kind: m[1].toLowerCase() === "nocite" ? "bibliography" : "citation",
          excerpt,
        });
      }
    }
  }
  return locations;
}

/**
 * Scan .tex sources for citation commands (\cite, \citep, \citet, \citealp,
 * \autocite, \parencite, \textcite, \footcite, \nocite — starred and
 * optional-arg forms included) and count citations per key per file.
 * Pure: takes file contents, returns key → [{file, count, lines}].
 */
export function scanCiteUsage(
  files: { file: string; content: string }[],
): CiteUsage {
  const usage: CiteUsage = {};
  for (const location of scanCitationLocations(files, undefined, false)) {
    const sites = (usage[location.key] ??= []);
    const site = sites.find((s) => s.file === location.file);
    if (site) {
      site.count++;
      site.lines.push(location.line);
    } else
      sites.push({ file: location.file, count: 1, lines: [location.line] });
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

/** A single unbroken claim can't blow out the verification prompt. */
const MAX_CLAIM_CHARS = 1500;

/**
 * The paragraph containing a given 1-indexed line — LaTeX's own sentence
 * unit, since it does not hard-wrap. Blank lines are the paragraph
 * boundary; comments are stripped first so a commented-out \cite never
 * pollutes the extracted text. Pure.
 */
export function claimContextAtLine(
  tex: string,
  line: number,
  maxChars = MAX_CLAIM_CHARS,
): string {
  const lines = stripComments(tex).split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
  let start = idx;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
  const context = lines
    .slice(start, end + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return context.length > maxChars ? `${context.slice(0, maxChars)}…` : context;
}

/** Scan every .tex file in a project directory. */
export function collectCiteUsage(projectPath: string): CiteUsage {
  const texFiles = listFiles(projectPath).filter((f) => f.endsWith(".tex"));
  const inputs: { file: string; content: string }[] = [];
  for (const file of texFiles) {
    try {
      inputs.push({
        file,
        content: readFileSync(join(projectPath, file), "utf8"),
      });
    } catch {
      /* unreadable file — skip */
    }
  }
  return scanCiteUsage(inputs);
}

/** Read-only: locations come from current project sources, never provider metadata. */
export function collectCitationLocations(
  projectPath: string,
  keys: string[],
): CitationLocation[] {
  if (!keys.length) return [];
  return scanCitationLocations(
    listFiles(projectPath)
      .filter((file) => file.endsWith(".tex"))
      .map((file) => ({
        file,
        content: readFileSync(join(projectPath, file), "utf8"),
      })),
    keys,
  );
}
