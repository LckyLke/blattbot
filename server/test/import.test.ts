import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBibliography, importBibtex } from "../src/citations.js";
import { parseBib } from "../src/bib.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-import-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const EXISTING = `@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann and Bengio, Yoshua},
  year = {2015},
  doi = {10.1038/nature14539}
}
`;

describe("importBibtex", () => {
  it("appends new entries to the first existing .bib and reports keys", () => {
    writeFileSync(join(dir, "refs.bib"), EXISTING);
    const result = importBibtex(
      dir,
      `@inproceedings{vaswani2017attention,
  title = {Attention is All you Need},
  author = {Vaswani, Ashish},
  year = {2017}
}`,
    );
    expect(result).toMatchObject({ added: ["vaswani2017attention"], skipped: [], bibFile: "refs.bib" });
    const entries = parseBib(readFileSync(join(dir, "refs.bib"), "utf8"));
    expect(entries.map((e) => e.key)).toEqual(["lecun2015deep", "vaswani2017attention"]);
  });

  it("creates references.bib when the project has no .bib yet", () => {
    const result = importBibtex(dir, `@misc{solo2024, title={Solo}}`);
    expect(result.bibFile).toBe("references.bib");
    expect(parseBib(readFileSync(join(dir, "references.bib"), "utf8"))).toHaveLength(1);
  });

  it("skips exact key matches, DOI duplicates, and title duplicates", () => {
    writeFileSync(join(dir, "refs.bib"), EXISTING);
    const result = importBibtex(
      dir,
      `@article{lecun2015deep, title={Whatever}, year={2015}}

@article{samedoi2015, title={Different Title Entirely}, doi={https://doi.org/10.1038/NATURE14539}}

@article{sametitle2015, title={Deep Learning!}, author={Someone Else}}

@article{fresh2020, title={A Genuinely New Paper}, year={2020}}`,
    );
    expect(result.added).toEqual(["fresh2020"]);
    expect(result.skipped).toEqual([
      { key: "lecun2015deep", reason: "key already in bibliography" },
      { key: "samedoi2015", reason: "duplicate of lecun2015deep (same doi)" },
      { key: "sametitle2015", reason: "duplicate of lecun2015deep (same title)" },
    ]);
  });

  it("dedupes within the pasted batch itself", () => {
    const result = importBibtex(
      dir,
      `@misc{a2020, title={The Same Long Paper Title}}
@misc{b2020, title={The same long paper title}}`,
    );
    expect(result.added).toEqual(["a2020"]);
    expect(result.skipped).toEqual([{ key: "b2020", reason: "duplicate of a2020 (same title)" }]);
  });

  it("preserves the original entry text verbatim", () => {
    const raw = `@article{styled2021,
  title   = {Original   {Spacing} Preserved},
  note    = "quoted value"
}`;
    importBibtex(dir, raw);
    expect(readFileSync(join(dir, "references.bib"), "utf8")).toContain("title   = {Original   {Spacing} Preserved}");
  });

  it("throws on input with no parseable entries", () => {
    expect(() => importBibtex(dir, "not bibtex at all")).toThrow(/no BibTeX entries/);
  });

  it("respects an explicit target bibFile", () => {
    writeFileSync(join(dir, "a.bib"), EXISTING);
    const result = importBibtex(dir, `@misc{extra2022, title={Extra}}`, "b.bib");
    expect(result.bibFile).toBe("b.bib");
    expect(parseBib(readFileSync(join(dir, "b.bib"), "utf8")).map((e) => e.key)).toEqual(["extra2022"]);
  });
});

describe("exportBibliography", () => {
  it("concatenates all .bib files with provenance comments", () => {
    writeFileSync(join(dir, "a.bib"), EXISTING);
    mkdirSync(join(dir, "chapters"));
    writeFileSync(join(dir, "chapters", "b.bib"), `@misc{other2020, title={Other}}`);
    const out = exportBibliography(dir);
    expect(out).toContain("% ---- a.bib ----");
    expect(out).toContain("% ---- chapters/b.bib ----");
    expect(parseBib(out).map((e) => e.key).sort()).toEqual(["lecun2015deep", "other2020"]);
  });

  it("omits the file header for a single .bib", () => {
    writeFileSync(join(dir, "a.bib"), EXISTING);
    expect(exportBibliography(dir)).not.toContain("% ----");
  });

  it("returns an empty string when there is nothing to export", () => {
    expect(exportBibliography(dir)).toBe("");
  });
});
