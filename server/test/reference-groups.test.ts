import { describe, expect, it } from "vitest";
import { groupReferences, referenceAuthors } from "../../web/src/reference-groups.js";
import type { RefEntry } from "../../web/src/api.js";
const paper = (key: string, author: string | null, extra: Partial<RefEntry> = {}): RefEntry => ({ key, author, file: "refs.bib", type: "article", title: key, year: "2025", doi: null, link: null, raw: key, usage: [], hasPdf: false, ...extra });

describe("reference grouping", () => {
  it("matches reordered full names while preserving organizations and excluding others", () => {
    expect(referenceAuthors("Smith, Ada and {Research and Development} and others")).toEqual(referenceAuthors("Ada Smith and {Research and Development}"));
    expect(referenceAuthors("Smith, Jr., John")).toEqual(referenceAuthors("John Smith Jr."));
    expect(referenceAuthors("{Research and Development}")).toHaveLength(1);
    expect(referenceAuthors("others and et al.")).toEqual([]);
    expect(referenceAuthors("García, Ana and Ana Garcia")).toHaveLength(1);
  });
  it("connects shared coauthors transitively, with each paper appearing exactly once", () => {
    const papers = [paper("a", "Smith, Ada and Bob Jones"), paper("b", "Ada Smith and Carl Doe"), paper("c", "Carl Doe"), paper("d", "Dana Solo"), paper("e", null)];
    const groups = groupReferences(papers, "authors");
    expect(groups.map(g => g.entries.map(e => e.key))).toEqual([["a", "b", "c"], ["d"], ["e"]]);
    expect(groups[0].detail).toContain("Ada Smith");
    expect(groups[0].detail).toContain("Carl Doe");
    expect(groups[1].label).toBe("No shared authors");
    expect(groups[2].label).toBe("Unknown authors");
  });
  it("does not merge authors solely by surname or initials", () => {
    expect(groupReferences([paper("a", "Ada Smith"), paper("b", "Adam Smith"), paper("c", "A. Smith")], "authors")[0].label).toBe("No shared authors");
  });
  it("sorts years newest first and unknown last, without changing original ordering", () => {
    const papers = [paper("old", null, { year: "1999" }), paper("unknown", null, { year: null }), paper("new", null)];
    expect(groupReferences(papers, "year").map(g => g.label)).toEqual(["2025", "1999", "Unknown year"]);
    expect(groupReferences(papers, "none")[0].entries.map(e => e.key)).toEqual(["old", "unknown", "new"]);
  });
  it("groups venue names case-insensitively and leaves missing venues explicit", () => {
    const papers = [paper("a", null, { metadata: { venue: "ICML" } }), paper("b", null, { metadata: { venue: "icml" } }), paper("c", null)];
    expect(groupReferences(papers, "venue").map(g => [g.label, g.entries.length])).toEqual([["ICML", 2], ["Unknown venue", 1]]);
  });
  it("separates project usage, groups related types, and preserves distinct file paths", () => {
    const papers = [paper("a", null, { type: "inproceedings", file: "a-b.bib", usage: [{ file: "main.tex", count: 2, lines: [3, 5] }] }), paper("b", null, { type: "conference", file: "a/b.bib" })];
    expect(groupReferences(papers, "usage").map(g => g.entries.length)).toEqual([1, 1]);
    expect(groupReferences(papers, "type")).toHaveLength(1);
    expect(groupReferences(papers, "file")).toHaveLength(2);
  });
  it("keeps A* distinct from A, orders rank groups, and preserves ranking editions", () => {
    const ranked = (key: string, rank: string, edition = "ICORE2026") => paper(key, null, { metadata: { conferenceRanking: { rank, edition, title: "Conference", acronym: "CONF", url: "https://portal.core.edu.au/conf-ranks/1/", checkedAt: "2026-09-23" } } });
    const groups = groupReferences([ranked("b", "B"), ranked("a", "A"), ranked("star", "A*"), paper("unknown", null), ranked("old", "A", "CORE2023")], "rank");
    expect(groups.map(g => g.label)).toEqual(["ICORE 2026 · A*", "CORE 2023 · A", "ICORE 2026 · A", "ICORE 2026 · B", "No conference rating"]);
  });
});
