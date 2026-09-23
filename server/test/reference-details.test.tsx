import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReferenceDetails from "../../web/src/components/ReferenceDetails.js";

describe("reference details", () => {
  it("shows the edition and rank with a link to the official conference record", () => {
    const html = renderToStaticMarkup(<ReferenceDetails metadata={{ venue: "ICML", conferenceRanking: { rank: "A*", edition: "ICORE2026", title: "International Conference on Machine Learning", acronym: "ICML", url: "https://portal.core.edu.au/conf-ranks/1121/", checkedAt: "2026-09-23" } }} />);
    expect(html).toContain("ICORE 2026 · A*");
    expect(html).toContain('href="https://portal.core.edu.au/conf-ranks/1121/"');
    expect(html).toContain("publication-year ranking");
  });
  it("hides unknown metadata and shows zero as a real sourced count", () => {
    expect(renderToStaticMarkup(<ReferenceDetails metadata={{}} />)).toBe("");
    const html = renderToStaticMarkup(<ReferenceDetails metadata={{ citationCount: 0, citationSource: "Semantic Scholar", venue: "ICML", venueType: "conference", venueSource: "BibTeX" }} />);
    expect(html).toContain("No citations indexed");
    expect(html).toContain("does not mean the paper has never been cited");
    expect(html).toContain("Semantic Scholar");
    expect(html).toContain("Conference: ICML");
  });
  it("labels journals accurately and only links to HTTP sources", () => {
    const html = renderToStaticMarkup(<ReferenceDetails metadata={{ citationCount: 1, citationSource: "OpenAlex", citationUrl: "javascript:alert(1)", venue: "Nature", venueType: "journal" }} />);
    expect(html.replace(/<[^>]*>/g, "")).toContain("1 citation · OpenAlex");
    expect(html).toContain("text-leaf");
    expect(html).toContain("Journal: Nature");
    expect(html).not.toContain("href");
    expect(renderToStaticMarkup(<ReferenceDetails metadata={{ citationCount: 5, citationUrl: "https://openalex.org/W1" }} />)).toContain('href="https://openalex.org/W1"');
  });
});
