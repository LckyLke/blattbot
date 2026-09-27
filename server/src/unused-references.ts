import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findEntrySpan } from "./bib.js";
import { readAllBibEntries } from "./citations.js";
import { listFiles } from "./latex.js";
import { collectCiteUsage, stripComments } from "./usage.js";

/** Conservative cleanup: retain explicit nocite entries and bibliography dependencies. */
export function unusedReferenceEntries(projectPath: string, all = readAllBibEntries(projectPath)) {
  for (const file of listFiles(projectPath).filter(file => file.endsWith(".tex"))) {
    const text = stripComments(readFileSync(join(projectPath, file), "utf8"));
    if (/\\nocite\s*\{[^}]*\*[^}]*\}/i.test(text)) return [];
  }
  const used = new Set(Object.keys(collectCiteUsage(projectPath)));
  // crossref/xref/xdata entries can be required without appearing in a cite command.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { entry } of all) {
      if (!used.has(entry.key)) continue;
      for (const field of ["crossref", "xref", "xdata", "entryset"]) {
        for (const key of (entry.fields[field] ?? "").split(",").map(key => key.trim()).filter(Boolean)) {
          if (!used.has(key)) { used.add(key); changed = true; }
        }
      }
    }
  }
  return all.filter(({ entry }) => !["string", "comment", "preamble"].includes(entry.type) && !used.has(entry.key));
}

/** Recompute usage at mutation time, then prepare every file before writing. */
export function deleteUnusedReferences(projectPath: string) {
  const unused = unusedReferenceEntries(projectPath);
  const edits = new Map<string, string>();
  for (const { file, entry } of unused) {
    const content = edits.get(file) ?? readFileSync(join(projectPath, file), "utf8");
    const span = findEntrySpan(content, entry.key);
    if (!span) throw new Error(`Could not locate ${entry.key} in ${file}`);
    edits.set(file, content.slice(0, span.start) + content.slice(span.end));
  }
  for (const [file, content] of edits) writeFileSync(join(projectPath, file), content);
  return unused.map(({ file, entry }) => ({ file, key: entry.key }));
}
