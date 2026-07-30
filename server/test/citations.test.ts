import { describe, expect, it } from "vitest";
import { arxivAtomToBibtex, mergeHits, type PaperHit } from "../src/citations.js";

const hit = (over: Partial<PaperHit>): PaperHit => ({
  ref: "10.1/x",
  title: "Some Paper",
  authors: "A. Author",
  source: "crossref",
  ...over,
});

describe("mergeHits", () => {
  it("dedupes across sources by DOI and enriches the first occurrence", () => {
    const s2 = [hit({ ref: "10.5555/tabpfn", doi: "10.5555/tabpfn", title: "TabPFN", source: "semanticscholar" })];
    const crossref = [
      hit({ ref: "10.5555/tabpfn", doi: "10.5555/tabpfn", title: "TabPFN", citations: 500, venue: "NeurIPS" }),
    ];
    const merged = mergeHits([s2, crossref], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("semanticscholar");
    expect(merged[0].citations).toBe(500);
    expect(merged[0].venue).toBe("NeurIPS");
  });

  it("dedupes DOI-less entries by normalized title", () => {
    const s2 = [hit({ ref: "arxiv:13.1", doi: undefined, title: "Translating Embeddings!", source: "semanticscholar" })];
    const dblp = [hit({ ref: "dblp:conf/nips/Bordes13", doi: undefined, title: "translating embeddings", source: "dblp" })];
    expect(mergeHits([s2, dblp], 10)).toHaveLength(1);
  });

  it("upgrades an arxiv ref to a DOI when a later source has one", () => {
    const s2 = [hit({ ref: "arxiv:2310.04562", doi: undefined, title: "ULTRA", source: "semanticscholar" })];
    const crossref = [hit({ ref: "10.9/ultra", doi: "10.9/ultra", title: "ULTRA" })];
    const merged = mergeHits([s2, crossref], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].ref).toBe("10.9/ultra");
  });

  it("keeps distinct papers and respects the limit", () => {
    const groups = [[hit({ title: "A", ref: "10.1/a" }), hit({ title: "B", ref: "10.1/b" }), hit({ title: "C", ref: "10.1/c" })]];
    expect(mergeHits(groups, 2)).toHaveLength(2);
  });
});

describe("arxivAtomToBibtex", () => {
  const xml = `<?xml version="1.0"?><feed xmlns:arxiv="http://arxiv.org/schemas/atom">
    <entry>
      <title>Neural Bellman-Ford Networks:
        A General GNN Framework</title>
      <published>2021-06-13T00:00:00Z</published>
      <author><name>Zhaocheng Zhu</name></author>
      <author><name>Jian Tang</name></author>
    </entry></feed>`;

  it("builds a parseable @misc entry with authors, year, and eprint", () => {
    const bib = arxivAtomToBibtex(xml, "2106.06935");
    expect(bib).toContain("@misc{arxiv210606935");
    expect(bib).toContain("Neural Bellman-Ford Networks: A General GNN Framework");
    expect(bib).toContain("Zhaocheng Zhu and Jian Tang");
    expect(bib).toContain("year = {2021}");
    expect(bib).toContain("eprint = {2106.06935}");
  });

  it("throws on an empty result", () => {
    expect(() => arxivAtomToBibtex("<feed></feed>", "1234.5678")).toThrow(/no entry/);
  });
});
