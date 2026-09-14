import { readAllBibEntries } from "../citations.js";
import { entryDoi } from "../bib.js";
import { collectCiteUsage, usageReport } from "../usage.js";
import { now } from "./store.js";

export interface BibliographyIssue {
  kind:
    | "undefined_key"
    | "duplicate_key"
    | "duplicate_work"
    | "case_collision"
    | "missing_fields";
  keys: string[];
  files: string[];
  detail: string;
}
/** Structural checks; publication identity remains audit_citations' job. */
export function checkBibliography(dir: string) {
  const all = readAllBibEntries(dir).filter(
    ({ entry }) => entry.type !== "string",
  );
  const report = usageReport(
    all.map(({ entry }) => entry.key),
    collectCiteUsage(dir),
  );
  const issues: BibliographyIssue[] = report.undefinedKeys.map(
    ({ key, files }) => ({
      kind: "undefined_key",
      keys: [key],
      files,
      detail: "Cited in the manuscript but not defined in a bibliography file.",
    }),
  );
  const groups = (by: (item: (typeof all)[number]) => string) => {
    const map = new Map<string, typeof all>();
    for (const item of all) {
      const value = by(item);
      if (value) map.set(value, [...(map.get(value) ?? []), item]);
    }
    return [...map.values()].filter((items) => items.length > 1);
  };
  for (const entries of groups(({ entry }) => entry.key))
    issues.push({
      kind: "duplicate_key",
      keys: [entries[0].entry.key],
      files: entries.map(({ file }) => file),
      detail:
        "This key has multiple definitions. Resolve the ambiguity before checking or citing its paper.",
    });
  for (const entries of groups(({ entry }) => entry.key.toLowerCase())) {
    const keys = [...new Set(entries.map(({ entry }) => entry.key))];
    if (keys.length > 1)
      issues.push({
        kind: "case_collision",
        keys,
        files: [...new Set(entries.map(({ file }) => file))],
        detail:
          "Keys differ only in letter case; check spelling and bibliography processor behavior.",
      });
  }
  const seen = new Set<string>();
  for (const by of [
    (item: (typeof all)[number]) =>
      entryDoi(item.entry.fields)?.toLowerCase() ?? "",
    (item: (typeof all)[number]) =>
      (item.entry.fields.title ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, ""),
  ]) {
    for (const entries of groups(by)) {
      const keys = [...new Set(entries.map(({ entry }) => entry.key))].sort();
      if (keys.length < 2 || seen.has(keys.join("\n"))) continue;
      seen.add(keys.join("\n"));
      issues.push({
        kind: "duplicate_work",
        keys,
        files: [...new Set(entries.map(({ file }) => file))],
        detail:
          "Same DOI or normalized title appears under different keys. Review versions before merging.",
      });
    }
  }
  for (const { entry, file } of all) {
    const missing = [
      !entry.fields.title && "title",
      !(entry.fields.author || entry.fields.editor) && "author/editor",
      !(entry.fields.year || entry.fields.date) && "year/date",
    ].filter(Boolean);
    if (missing.length)
      issues.push({
        kind: "missing_fields",
        keys: [entry.key],
        files: [file],
        detail: `Review missing metadata: ${missing.join(", ")}. Requirements depend on entry type and bibliography style.`,
      });
  }
  return {
    at: now(),
    entries: all.length,
    issues,
    unusedKeys: [...new Set(report.unusedKeys)],
    note: "Keys are arbitrary identifiers. This checks links and metadata across project .tex/.bib files. Use compilation for BibTeX/Biber syntax and Verify references for publication identity.",
  };
}
