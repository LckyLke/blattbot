/** Disclose changed citation passages that bypassed direct source reading. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimContextAtLine, collectCiteUsage } from "./usage.js";
import { readAllBibEntries } from "./citations.js";

export function citationPassages(dir: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const files = new Map<string, string>();
  const identities = new Map(readAllBibEntries(dir).map(({ entry }) => [entry.key,
    JSON.stringify([entry.fields.title, entry.fields.doi, entry.fields.year, entry.fields.eprint])]));
  for (const [key, sites] of Object.entries(collectCiteUsage(dir))) {
    const passages = new Set<string>();
    for (const site of sites) {
      let tex = files.get(site.file);
      if (tex === undefined) {
        tex = readFileSync(join(dir, site.file), "utf8");
        files.set(site.file, tex);
      }
      for (const line of site.lines) passages.add(`${identities.get(key) ?? "unknown reference"}\n${claimContextAtLine(tex, line, Infinity)}`);
    }
    result.set(key, passages);
  }
  return result;
}

export function unreadCitationChanges(before: Map<string, Set<string>>, after: Map<string, Set<string>>, reads: Set<string>): string[] {
  return [...after].filter(([key, passages]) => !reads.has(key) && [...passages].some((passage) => !before.get(key)?.has(passage)))
    .map(([key]) => key).sort();
}
