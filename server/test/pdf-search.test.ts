import { describe, expect, it } from "vitest";
import { findPdfMatches } from "../../web/src/pdf-search.js";
describe("PDF find with reversible text normalization", () => {
  it("locates every ligature and hyphenated match at its actual raw offsets", () => {
    const raw = "Heading. An efﬁcient exam- ple and another example are shown.";
    const efficient = findPdfMatches(raw, "efficient").hits[0];
    expect(raw.slice(efficient.start, efficient.end)).toBe("efﬁcient");
    const matches = findPdfMatches(raw, "example").hits;
    expect(matches).toHaveLength(2);
    expect(matches.map(m => raw.slice(m.start, m.end))).toEqual(["exam- ple", "example"]);
  });
  it("handles whitespace, soft hyphens and single-character scientific symbols", () => {
    const raw = "Here α appears. A co\u00adherent\n result.";
    const match = findPdfMatches(raw, "coherent result").hits[0];
    expect(raw.slice(match.start, match.end)).toBe("co\u00adherent\n result");
    expect(findPdfMatches(raw, "α").hits).toHaveLength(1);
  });
  it("supports case, whole-word matching, and visible result limits", () => {
    expect(findPdfMatches("Net network NET", "net", { wholeWord: true }).hits).toHaveLength(2);
    expect(findPdfMatches("Net network NET", "Net", { caseSensitive: true, wholeWord: true }).hits).toHaveLength(1);
    expect(findPdfMatches("a a a", "a", { limit: 2 })).toMatchObject({ hits: [{ start: 0, end: 1 }, { start: 2, end: 3 }], truncated: true });
  });
  it("does not invent a page-start hit or confuse symbol normalization with coordinates", () => {
    const raw = "Different start. Fullwidth ＡＢ and normal AB.";
    expect(findPdfMatches(raw, "AB").hits.map(h => raw.slice(h.start, h.end))).toEqual(["ＡＢ", "AB"]);
    expect(findPdfMatches(raw, "not there").hits).toEqual([]);
  });
});
