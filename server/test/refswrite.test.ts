import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRefEntry, deleteRefEntry, updateRefEntry, readAllBibEntries } from "../src/citations.js";

const FIRST = `@article{lecun2015deep,
  title = {Deep learning},
  author = {LeCun, Yann},
  year = {2015}
}`;

const SECOND = `@inproceedings{vaswani2017attention,
  title = {Attention is All You Need},
  author = {Vaswani, Ashish},
  year = {2017}
}`;

const BIB = `${FIRST}\n\n${SECOND}\n`;

describe("manual reference editing (add/update/delete)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blattbot-refswrite-"));
    writeFileSync(join(dir, "refs.bib"), BIB);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (file = "refs.bib") => readFileSync(join(dir, file), "utf8");
  const keys = () => readAllBibEntries(dir).map((x) => x.entry.key);

  describe("addRefEntry", () => {
    it("appends one entry to the first existing .bib file", () => {
      const r = addRefEntry(dir, "@misc{note2024,\n  title = {A Note}\n}");
      expect(r).toEqual({ key: "note2024", bibFile: "refs.bib" });
      expect(read()).toBe(BIB + "\n@misc{note2024,\n  title = {A Note}\n}\n");
      expect(keys()).toContain("note2024");
    });

    it("auto-renames a colliding key", () => {
      const r = addRefEntry(dir, "@misc{lecun2015deep,\n  title = {Different}\n}");
      expect(r.key).toBe("lecun2015deep-2");
      expect(read()).toContain("@misc{lecun2015deep-2,");
    });

    it("creates references.bib when the project has no .bib file", () => {
      rmSync(join(dir, "refs.bib"));
      const r = addRefEntry(dir, "@misc{solo2024,\n  title = {Solo}\n}");
      expect(r.bibFile).toBe("references.bib");
      expect(read("references.bib")).toBe("@misc{solo2024,\n  title = {Solo}\n}\n");
    });

    it("honors an explicit target bibFile", () => {
      const r = addRefEntry(dir, "@misc{aimed2024,\n  title = {Aimed}\n}", "other.bib");
      expect(r.bibFile).toBe("other.bib");
      expect(existsSync(join(dir, "other.bib"))).toBe(true);
      expect(read()).toBe(BIB); // the existing file is untouched
    });

    it("rejects zero and multiple entries", () => {
      expect(() => addRefEntry(dir, "not bibtex at all")).toThrow(/no BibTeX entry/);
      expect(() => addRefEntry(dir, "@misc{a,title={A}}\n@misc{b,title={B}}")).toThrow(
        /exactly one/,
      );
      expect(read()).toBe(BIB);
    });
  });

  describe("updateRefEntry", () => {
    it("replaces the entry's span in place, leaving neighbors byte-identical", () => {
      const edited = "@article{lecun2015deep,\n  title = {Deep Learning, Revised},\n  year = {2015}\n}";
      const r = updateRefEntry(dir, "lecun2015deep", edited);
      expect(r).toEqual({ key: "lecun2015deep", bibFile: "refs.bib" });
      expect(read()).toBe(`${edited}\n\n${SECOND}\n`);
    });

    it("renames when the edited key differs, keeping it unique against others", () => {
      const r = updateRefEntry(dir, "lecun2015deep", "@article{vaswani2017attention,\n  title = {X}\n}");
      expect(r.key).toBe("vaswani2017attention-2"); // collision with the other entry
      expect(read()).toContain("@article{vaswani2017attention-2,");
      expect(keys().sort()).toEqual(["vaswani2017attention", "vaswani2017attention-2"]);
    });

    it("allows a plain rename to a fresh key", () => {
      const r = updateRefEntry(dir, "lecun2015deep", "@article{lecun2015renamed,\n  title = {Deep learning}\n}");
      expect(r.key).toBe("lecun2015renamed");
      expect(keys()).not.toContain("lecun2015deep");
    });

    it("throws for unknown keys and invalid bibtex", () => {
      expect(() => updateRefEntry(dir, "ghost", "@misc{g,title={G}}")).toThrow(/unknown citation key/);
      expect(() => updateRefEntry(dir, "lecun2015deep", "junk")).toThrow(/no BibTeX entry/);
      expect(read()).toBe(BIB);
    });
  });

  describe("deleteRefEntry", () => {
    it("removes the entry plus its adjacent blank line", () => {
      const r = deleteRefEntry(dir, "lecun2015deep");
      expect(r).toEqual({ bibFile: "refs.bib" });
      expect(read()).toBe(`${SECOND}\n`);
    });

    it("removes the last entry without leaving a trailing blank line", () => {
      deleteRefEntry(dir, "vaswani2017attention");
      expect(read()).toBe(`${FIRST}\n`);
    });

    it("empties the file when the only entry is deleted", () => {
      writeFileSync(join(dir, "refs.bib"), `${FIRST}\n`);
      deleteRefEntry(dir, "lecun2015deep");
      expect(read()).toBe("");
    });

    it("throws for unknown keys", () => {
      expect(() => deleteRefEntry(dir, "ghost")).toThrow(/unknown citation key/);
      expect(read()).toBe(BIB);
    });
  });
});
