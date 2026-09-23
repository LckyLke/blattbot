import type { RefEntry } from "./api";

export const REFERENCE_GROUPINGS = [
  ["none", "No grouping"],
  ["authors", "Shared authors"],
  ["year", "Publication year"],
  ["venue", "Conference / journal"],
  ["rank", "Conference ranking (CORE)"],
  ["usage", "Cited / unused"],
  ["type", "Publication type"],
  ["file", "Bibliography file"],
] as const;
export type ReferenceGrouping = typeof REFERENCE_GROUPINGS[number][0];
export interface ReferenceGroup {
  id: string;
  label: string;
  detail?: string;
  entries: RefEntry[];
}

const normalize = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const plainName = (name: string) => name.replace(/\\['"`^~=.]\s*\{?(\p{L})\}?/gu, "$1").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

/** Split BibTeX authors without splitting protected organization names. */
export function referenceAuthors(author: string | null): { id: string; label: string }[] {
  if (!author) return [];
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < author.length; i++) {
    if (author[i] === "\\") { i++; continue; }
    if (author[i] === "{") depth++;
    else if (author[i] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const separator = /^\s+and\s+/i.exec(author.slice(i));
      if (separator) {
        parts.push(author.slice(start, i));
        i += separator[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(author.slice(start));
  const unique = new Map<string, { id: string; label: string }>();
  for (const part of parts) {
    const raw = part.trim();
    const protectedName = raw.startsWith("{") && raw.endsWith("}");
    const name = plainName(raw);
    if (!name || /^(others|et\s+al\.?)$/i.test(name)) continue;
    const pieces = name.split(",").map(p => p.trim());
    // BibTeX supports Family, Given and Family, Suffix, Given.
    const label = protectedName || pieces.length === 1 ? name
      : [pieces.at(-1), pieces[0], ...pieces.slice(1, -1)].filter(Boolean).join(" ");
    const id = normalize(label);
    if (id) unique.set(id, { id, label });
  }
  return [...unique.values()];
}

function authorGroups(entries: RefEntry[]): ReferenceGroup[] {
  const parents = entries.map((_, i) => i);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const authors = entries.map(e => referenceAuthors(e.author));
  const occurrences = new Map<string, { label: string; papers: number[] }>();
  authors.forEach((names, index) => names.forEach(name => {
    const previous = occurrences.get(name.id);
    if (previous) {
      parents[root(index)] = root(previous.papers[0]);
      previous.papers.push(index);
    } else occurrences.set(name.id, { label: name.label, papers: [index] });
  }));
  const clusters = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const group = root(i);
    const existing = clusters.get(group);
    if (existing) existing.push(i); else clusters.set(group, [i]);
  });
  const shared: ReferenceGroup[] = [];
  const solo: RefEntry[] = [], unknown: RefEntry[] = [];
  for (const indices of clusters.values()) {
    if (indices.length === 1) {
      (authors[indices[0]].length ? solo : unknown).push(entries[indices[0]]);
      continue;
    }
    const names = [...new Set(indices.flatMap(i => authors[i].map(a => a.id)))]
      .filter(id => occurrences.get(id)!.papers.length > 1)
      .sort((a, b) => occurrences.get(b)!.papers.length - occurrences.get(a)!.papers.length || a.localeCompare(b));
    const labels = names.map(id => occurrences.get(id)!.label);
    shared.push({
      id: `authors:${JSON.stringify([...names].sort())}`,
      label: labels.slice(0, 2).join(" · ") + (labels.length > 2 ? ` +${labels.length - 2}` : ""),
      detail: `Connected by shared author names: ${labels.join("; ")}`,
      entries: indices.map(i => entries[i]),
    });
  }
  shared.sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  if (solo.length) shared.push({ id: "authors:solo", label: "No shared authors", entries: solo });
  if (unknown.length) shared.push({ id: "authors:unknown", label: "Unknown authors", entries: unknown });
  return shared;
}

const TYPE_LABELS: Record<string, string> = {
  article: "Journal articles", inproceedings: "Conference papers", conference: "Conference papers",
  proceedings: "Conference proceedings", book: "Books", incollection: "Book chapters", inbook: "Book chapters",
  phdthesis: "Theses", mastersthesis: "Theses", thesis: "Theses", techreport: "Reports", report: "Reports",
  unpublished: "Unpublished works", misc: "Other works", online: "Online sources",
};

/** Group the whole bibliography before filtering, so searches preserve author clusters. */
export function groupReferences(entries: RefEntry[], mode: ReferenceGrouping): ReferenceGroup[] {
  if (mode === "none") return [{ id: "all", label: "All references", entries }];
  if (mode === "authors") return authorGroups(entries);
  const groups = new Map<string, ReferenceGroup>();
  for (const entry of entries) {
    let label: string;
    let unknown = false;
    switch (mode) {
      case "year": label = entry.year?.replace(/[{}]/g, "").trim() || "Unknown year"; unknown = label === "Unknown year"; break;
      case "venue": label = entry.metadata?.venue?.trim() || "Unknown venue"; unknown = label === "Unknown venue"; break;
      case "rank": {
        const ranking = entry.metadata?.conferenceRanking;
        label = ranking ? `${ranking.edition.replace(/(\d{4})$/, " $1")} · ${ranking.rank}` : "No conference rating";
        unknown = !ranking;
        break;
      }
      case "usage": label = entry.usage.some(u => u.count > 0) ? "Cited in this project" : "Unused in this project"; break;
      case "file": label = entry.file; break;
      case "type": label = TYPE_LABELS[entry.type.toLowerCase()] ?? entry.type; break;
    }
    const id = `${mode}:${unknown ? "unknown" : mode === "file" || mode === "rank" ? label : normalize(label)}`;
    const existing = groups.get(id);
    if (existing) existing.entries.push(entry);
    else groups.set(id, { id, label, entries: [entry] });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === `${mode}:unknown`) return 1;
    if (b.id === `${mode}:unknown`) return -1;
    if (mode === "rank") {
      const order = ["A*", "A", "B", "Australasian B", "C", "Australasian C"];
      const rankOrder = (group: ReferenceGroup) => {
        const index = order.indexOf(group.entries[0].metadata!.conferenceRanking!.rank);
        return index === -1 ? order.length : index;
      };
      return rankOrder(a) - rankOrder(b) || a.label.localeCompare(b.label);
    }
    return mode === "year" ? b.label.localeCompare(a.label, undefined, { numeric: true }) : a.label.localeCompare(b.label);
  });
}
