import { describe, expect, it } from "vitest";
import {
  ensureUniqueKey,
  entryDoi,
  findDuplicate,
  findEntrySpan,
  normalizeKey,
  parseBib,
  parseEntrySource,
  rewriteKey,
} from "../src/bib.js";

const SAMPLE = `
@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  journal = {Nature},
  year = {2015},
  doi = {10.1038/nature14539}
}

@inproceedings{vaswani2017attention,
  title = "Attention is All you Need",
  author = "Vaswani, Ashish and Shazeer, Noam",
  year = 2017,
  booktitle = {NeurIPS}
}

@book{knuth1984texbook,
  title = {The {\\TeX}book},
  author = {Knuth, Donald E.},
  year = {1984}
}
`;

describe("parseBib", () => {
  it("parses multiple entries with braced, quoted, and bare values", () => {
    const entries = parseBib(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ type: "article", key: "lecun2015deep" });
    expect(entries[0].fields.title).toBe("Deep learning");
    expect(entries[0].fields.doi).toBe("10.1038/nature14539");
    expect(entries[1].fields.title).toBe("Attention is All you Need");
    expect(entries[1].fields.year).toBe("2017");
  });

  it("handles nested braces in values", () => {
    const entries = parseBib(SAMPLE);
    expect(entries[2].fields.title).toContain("TeX");
  });

  it("keeps the raw entry text", () => {
    const entries = parseBib(SAMPLE);
    expect(entries[0].raw).toMatch(/^@article\{lecun2015deep,/);
    expect(entries[0].raw.trim().endsWith("}")).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(parseBib("")).toEqual([]);
    expect(parseBib("% just a comment")).toEqual([]);
  });
});

describe("normalizeKey", () => {
  it("builds lastnameYEARtitleword from 'Last, First' authors", () => {
    expect(normalizeKey("LeCun, Yann and Bengio, Yoshua", "2015", "Deep learning")).toBe(
      "lecun2015deep",
    );
  });

  it("handles 'First Last' author format", () => {
    expect(normalizeKey("Ashish Vaswani and Noam Shazeer", "2017", "Attention is all you need")).toBe(
      "vaswani2017attention",
    );
  });

  it("skips stopwords when picking a title word", () => {
    expect(normalizeKey("Smith, J.", "2020", "On the Origin of Species")).toBe("smith2020origin");
  });

  it("strips accents and non-ascii", () => {
    expect(normalizeKey("Gödel, Kurt", "1931", "Über formal unentscheidbare Sätze")).toBe(
      "godel1931uber",
    );
  });

  it("tolerates missing pieces", () => {
    expect(normalizeKey(undefined, undefined, undefined)).toBe("unknown");
    expect(normalizeKey("Doe, Jane", "1999", undefined)).toBe("doe1999");
  });
});

describe("ensureUniqueKey", () => {
  it("returns the key when unused", () => {
    expect(ensureUniqueKey("smith2020", new Set())).toBe("smith2020");
  });
  it("appends -2, -3, … on collision", () => {
    expect(ensureUniqueKey("smith2020", new Set(["smith2020"]))).toBe("smith2020-2");
    expect(ensureUniqueKey("smith2020", new Set(["smith2020", "smith2020-2"]))).toBe("smith2020-3");
  });
});

describe("rewriteKey", () => {
  it("replaces the key while preserving the body", () => {
    const raw = "@article{OLD_KEY_2020, title={X}}";
    expect(rewriteKey(raw, "new2020key")).toBe("@article{new2020key, title={X}}");
  });
});

describe("findEntrySpan", () => {
  it("returns the exact source span of an entry, matching parseBib's raw text", () => {
    for (const entry of parseBib(SAMPLE)) {
      const span = findEntrySpan(SAMPLE, entry.key);
      expect(span).not.toBeNull();
      expect(SAMPLE.slice(span!.start, span!.end)).toBe(entry.raw);
    }
  });

  it("balances nested braces in values", () => {
    const content =
      "@book{knuth1984texbook,\n  title = {The {\\TeX}book {with {deeply} nested} braces},\n  year = {1984}\n}\n\n@article{next2020,\n  title = {Next}\n}\n";
    const span = findEntrySpan(content, "knuth1984texbook")!;
    const raw = content.slice(span.start, span.end);
    expect(raw.startsWith("@book{knuth1984texbook,")).toBe(true);
    expect(raw.endsWith("}")).toBe(true);
    expect(raw).not.toContain("@article");
    expect(content.slice(span.end)).toContain("@article{next2020,");
  });

  it("skips @string headers (never matched, body consumed)", () => {
    const content =
      '@string{neurips = "Advances in Neural Information Processing Systems"}\n\n@inproceedings{vaswani2017attention,\n  title = {Attention},\n  booktitle = neurips\n}\n';
    const span = findEntrySpan(content, "vaswani2017attention")!;
    expect(content.slice(span.start, span.end).startsWith("@inproceedings{vaswani2017attention,")).toBe(true);
    // The @string's name is not an entry key.
    expect(findEntrySpan(content, "neurips")).toBeNull();
  });

  it("is not derailed by braces inside quoted values", () => {
    const content =
      '@article{first2020,\n  note = "an { unbalanced brace in quotes",\n  year = {2020}\n}\n\n@article{second2021,\n  title = {Second}\n}\n';
    const first = findEntrySpan(content, "first2020")!;
    expect(content.slice(first.start, first.end).endsWith("}")).toBe(true);
    expect(content.slice(first.start, first.end)).not.toContain("@article{second2021");
    const second = findEntrySpan(content, "second2021")!;
    expect(content.slice(second.start, second.end)).toBe(
      "@article{second2021,\n  title = {Second}\n}",
    );
  });

  it("returns null for unknown keys and empty content", () => {
    expect(findEntrySpan(SAMPLE, "nope")).toBeNull();
    expect(findEntrySpan("", "anything")).toBeNull();
  });
});

describe("findDuplicate", () => {
  const entries = parseBib(SAMPLE);

  it("matches by DOI regardless of doi.org prefix and case", () => {
    expect(findDuplicate(entries, "https://doi.org/10.1038/NATURE14539")).toMatchObject({
      key: "lecun2015deep",
      reason: "doi",
    });
  });

  it("matches by normalized title", () => {
    expect(findDuplicate(entries, undefined, "attention is ALL you need!")).toMatchObject({
      key: "vaswani2017attention",
      reason: "title",
    });
  });

  it("returns undefined when nothing matches", () => {
    expect(findDuplicate(entries, "10.9999/nope", "A Totally Different Paper")).toBeUndefined();
  });

  it("strips a doi: prefix from the incoming DOI", () => {
    expect(findDuplicate(entries, "doi:10.1038/nature14539")).toMatchObject({
      key: "lecun2015deep",
      reason: "doi",
    });
  });

  it("matches a doi-shaped url field on an existing entry", () => {
    const urlOnly = parseBib(
      "@article{ho2020ddpm,\n  title = {Denoising Diffusion Probabilistic Models},\n  url = {https://doi.org/10.5555/3495724}\n}",
    );
    expect(findDuplicate(urlOnly, "10.5555/3495724")).toMatchObject({
      key: "ho2020ddpm",
      reason: "doi",
    });
  });
});

describe("entryDoi", () => {
  it("normalizes the doi field and falls back to a doi.org url", () => {
    expect(entryDoi({ doi: "https://doi.org/10.1038/NATURE14539" })).toBe("10.1038/nature14539");
    expect(entryDoi({ doi: "doi:10.1038/nature14539" })).toBe("10.1038/nature14539");
    expect(entryDoi({ url: "https://dx.doi.org/10.5555/X" })).toBe("10.5555/x");
    expect(entryDoi({ url: "https://arxiv.org/abs/2106.06935" })).toBeUndefined();
    expect(entryDoi({})).toBeUndefined();
  });
});

describe("parseEntrySource", () => {
  it("keeps braces inside field values and collapses whitespace", () => {
    const raw = "@Article{key1,\n  title = {The {\\TeX}book\n    revisited},\n  year = 1984,\n  note = \"quoted\"\n}";
    const entry = parseEntrySource(raw)!;
    expect(entry.type).toBe("article");
    expect(entry.key).toBe("key1");
    expect(entry.fields).toEqual([
      { name: "title", value: "The {\\TeX}book revisited" },
      { name: "year", value: "1984" },
      { name: "note", value: "quoted" },
    ]);
  });

  it("returns null for non-entries", () => {
    expect(parseEntrySource("not bibtex")).toBeNull();
  });
});
