import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCitation,
  braceProtectTitle,
  formatAddCitationResult,
  normalizeEntryBibtex,
} from "../src/citations.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-addcite-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const read = () => readFileSync(join(dir, "refs.bib"), "utf8");

const EXISTING = `@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann},
  journal = {Nature},
  year = {2015},
  doi = {10.1038/nature14539}
}
`;

const textRes = (body: string) => ({ ok: true, status: 200, text: async () => body });
const jsonRes = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Stub fetch: doi.org serves `bibtex`; Crossref query.title serves `crossref`. */
function stubFetch(opts: { bibtex?: string; arxivAtom?: string; crossref?: any }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith("https://doi.org/") && opts.bibtex) return textRes(opts.bibtex);
      if (u.startsWith("https://export.arxiv.org/") && opts.arxivAtom) return textRes(opts.arxivAtom);
      if (u.startsWith("https://api.crossref.org/works?query.title=")) {
        if (opts.crossref instanceof Error) throw opts.crossref;
        return jsonRes(200, opts.crossref ?? { message: { items: [] } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const ARXIV_ATOM = `<feed>
  <entry>
    <title>Neural Bellman-Ford Networks: A General Framework for Link Prediction</title>
    <name>Zhaocheng Zhu</name>
    <name>Jian Tang</name>
    <published>2021-06-13T00:00:00Z</published>
  </entry>
</feed>`;

describe("braceProtectTitle", () => {
  it("wraps acronyms and mixed-case words, leaving plain words alone", () => {
    expect(braceProtectTitle("Scaling GPT-4 to the Limit")).toBe("Scaling {GPT-4} to the Limit");
    expect(braceProtectTitle("Reading arXiv preprints with BERT")).toBe(
      "Reading {arXiv} preprints with {BERT}",
    );
    expect(braceProtectTitle("Deep learning for images")).toBe("Deep learning for images");
  });

  it("never double-braces text that is already protected", () => {
    expect(braceProtectTitle("{GPT-4} in the wild")).toBe("{GPT-4} in the wild");
    expect(braceProtectTitle("The {\\TeX}book revisited")).toBe("The {\\TeX}book revisited");
  });

  it("keeps punctuation outside the braces", () => {
    expect(braceProtectTitle("Beyond GPT-4: what next?")).toBe("Beyond {GPT-4}: what next?");
  });
});

describe("normalizeEntryBibtex", () => {
  it("re-serializes with 2-space indent, one field per line, stripping abstract and keywords", () => {
    const { bibtex, warnings } = normalizeEntryBibtex(
      '@Article{ RaW_KEY , title={Deep learning}, author="LeCun, Yann",\n journal={Nature},  year = 2015,\n abstract={Long text.}, keywords={deep, nets}}',
    );
    expect(bibtex).toBe(
      "@article{RaW_KEY,\n  title = {Deep learning},\n  author = {LeCun, Yann},\n  journal = {Nature},\n  year = {2015}\n}",
    );
    expect(warnings).toEqual([]);
  });

  it("overrides the key and adds a DOI on request", () => {
    const { bibtex } = normalizeEntryBibtex("@misc{x, title={T}, eprint={2106.06935}, year={2021}}", {
      key: "zhu2021neural",
      addDoi: "10.1109/test.1",
    });
    expect(bibtex).toContain("@misc{zhu2021neural,");
    expect(bibtex).toContain("  doi = {10.1109/test.1}");
  });

  it("warns on missing required fields per entry type", () => {
    expect(normalizeEntryBibtex("@article{a, title={T}}").warnings).toEqual([
      "field journal missing",
      "field year missing",
    ]);
    expect(normalizeEntryBibtex("@inproceedings{b, title={T}, year={2020}}").warnings).toEqual([
      "field booktitle missing",
    ]);
    expect(normalizeEntryBibtex("@misc{c, title={T}, year={2020}}").warnings).toEqual([
      "field eprint/url missing",
    ]);
    expect(
      normalizeEntryBibtex("@misc{d, title={T}, url={https://x.example}, year={2020}}").warnings,
    ).toEqual([]);
  });
});

describe("addCitation", () => {
  it("refuses a DOI already in the bibliography and names the matching field", async () => {
    writeFileSync(join(dir, "refs.bib"), EXISTING);
    stubFetch({
      bibtex: "@article{dup1, title={Something Else Entirely}, journal={Nature}, year={2015}, doi={https://doi.org/10.1038/NATURE14539}}",
    });
    const r = await addCitation(dir, "10.1038/nature14539");
    expect(r).toMatchObject({ status: "duplicate", key: "lecun2015deep", bibFile: "refs.bib", matched: "doi" });
    expect(read()).toBe(EXISTING); // nothing appended
  });

  it("refuses a duplicate by normalized title", async () => {
    writeFileSync(join(dir, "refs.bib"), EXISTING);
    stubFetch({
      bibtex: "@article{dup2, title={DEEP: Learning!}, journal={Nature}, year={2015}, doi={10.9999/other}}",
    });
    // "DEEP: Learning!" normalizes to the existing "Deep learning".
    const r = await addCitation(dir, "10.9999/other");
    expect(r).toMatchObject({ status: "duplicate", key: "lecun2015deep", matched: "title" });
  });

  it("suffixes -2 when a different work generates a colliding key", async () => {
    writeFileSync(join(dir, "refs.bib"), EXISTING);
    stubFetch({
      bibtex: "@article{other, title={Deep networks at scale}, author={LeCun, Yann}, journal={Science}, year={2015}, doi={10.9999/scale}}",
    });
    const r = await addCitation(dir, "10.9999/scale");
    expect(r.status).toBe("added");
    expect(r.key).toBe("lecun2015deep-2");
    expect(read()).toContain("@article{lecun2015deep-2,");
  });

  it("brace-protects the title and strips abstract/keywords in the written entry", async () => {
    stubFetch({
      bibtex: "@article{gpt, title={Evaluating GPT-4 on BIG-Bench}, author={Doe, Jane}, journal={JMLR}, year={2023}, doi={10.9999/gpt}, abstract={Wall of text.}, keywords={llms}}",
    });
    const r = await addCitation(dir, "10.9999/gpt");
    expect(r.status).toBe("added");
    const written = readFileSync(join(dir, "references.bib"), "utf8");
    expect(written).toContain("title = {Evaluating {GPT-4} on {BIG-Bench}}");
    expect(written).not.toContain("abstract");
    expect(written).not.toContain("keywords");
  });

  it("reports missing required fields as warnings without touching the entry", async () => {
    stubFetch({ bibtex: "@article{thin, title={A Thin Record}, author={Doe, Jane}, doi={10.9999/thin}}" });
    const r = await addCitation(dir, "10.9999/thin");
    expect(r.status).toBe("added");
    expect(r.warnings).toEqual(["field journal missing", "field year missing"]);
    expect(readFileSync(join(dir, "references.bib"), "utf8")).not.toContain("note");
  });

  it("upgrades an arXiv ref to the published DOI when Crossref confirms the title", async () => {
    stubFetch({
      arxivAtom: ARXIV_ATOM,
      crossref: {
        message: {
          items: [
            { DOI: "10.48550/arXiv.2106.06935", title: ["Neural Bellman-Ford Networks: A General Framework for Link Prediction"] },
            { DOI: "10.1109/TNNLS.2022.1234", title: ["Neural Bellman-Ford Networks: A General Framework for Link Prediction"] },
          ],
        },
      },
    });
    const r = await addCitation(dir, "arxiv:2106.06935");
    expect(r.status).toBe("added");
    // The 10.48550 preprint DOI is skipped; the real published DOI wins.
    expect(r.upgradedDoi).toBe("10.1109/tnnls.2022.1234");
    const written = readFileSync(join(dir, "references.bib"), "utf8");
    expect(written).toContain("doi = {10.1109/tnnls.2022.1234}");
    expect(written).toContain("eprint = {2106.06935}");
  });

  it("keeps the plain arXiv entry when the Crossref lookup misses or fails", async () => {
    stubFetch({
      arxivAtom: ARXIV_ATOM,
      crossref: { message: { items: [{ DOI: "10.1/unrelated", title: ["A Totally Different Paper"] }] } },
    });
    const miss = await addCitation(dir, "arxiv:2106.06935");
    expect(miss.status).toBe("added");
    expect(miss.upgradedDoi).toBeUndefined();
    expect(readFileSync(join(dir, "references.bib"), "utf8")).not.toContain("doi =");

    rmSync(join(dir, "references.bib"));
    stubFetch({ arxivAtom: ARXIV_ATOM, crossref: new Error("crossref down") });
    const failed = await addCitation(dir, "arxiv:2106.06935");
    expect(failed.status).toBe("added"); // silent on failure
    expect(failed.upgradedDoi).toBeUndefined();
  });

  it("dedupes an arXiv ref whose published DOI is already in the bibliography", async () => {
    writeFileSync(
      join(dir, "refs.bib"),
      "@article{zhu2022neural,\n  title = {A Journal Version With Another Name},\n  doi = {10.1109/TNNLS.2022.1234}\n}\n",
    );
    stubFetch({
      arxivAtom: ARXIV_ATOM,
      crossref: {
        message: {
          items: [{ DOI: "10.1109/TNNLS.2022.1234", title: ["Neural Bellman-Ford Networks: A General Framework for Link Prediction"] }],
        },
      },
    });
    const r = await addCitation(dir, "arxiv:2106.06935");
    expect(r).toMatchObject({ status: "duplicate", key: "zhu2022neural", matched: "doi" });
  });
});

describe("formatAddCitationResult", () => {
  it("tells the agent to reuse the existing key, naming the matched field", () => {
    expect(
      formatAddCitationResult({ status: "duplicate", key: "k1", bibFile: "refs.bib", matched: "doi" }),
    ).toBe("Already in bibliography as \\cite{k1} (refs.bib; matched by DOI). Do not add it again.");
    expect(
      formatAddCitationResult({ status: "duplicate", key: "k1", bibFile: "refs.bib", matched: "title" }),
    ).toContain("matched by title");
  });

  it("mentions the upgrade and warnings on success", () => {
    const text = formatAddCitationResult({
      status: "added",
      key: "zhu2021neural",
      bibFile: "refs.bib",
      entryPreview: "@misc{zhu2021neural,",
      warnings: ["field year missing"],
      upgradedDoi: "10.1109/x",
    });
    expect(text).toBe(
      "Added to refs.bib as \\cite{zhu2021neural}.\n" +
        "Published version found: 10.1109/x — using it.\n" +
        "Warning: field year missing.\n" +
        "@misc{zhu2021neural,",
    );
  });
});
