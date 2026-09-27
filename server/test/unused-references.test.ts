import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteUnusedReferences, unusedReferenceEntries } from "../src/unused-references.js";

let dir: string;
const write = (file: string, text: string) => writeFileSync(join(dir, file), text);
const read = (file: string) => readFileSync(join(dir, file), "utf8");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-unused-"));
  write("main.tex", "\\cite{keep}");
  write("refs.bib", "% Preserve this comment\n@misc{keep,title={Keep}}\n@misc{unused,title={Remove}}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe("delete unused references", () => {
  it("removes unused entries across files, including duplicate keys, preserving cited source and comments", () => {
    write("other.bib", "@misc{unused,title={Other copy}}\n@misc{keep,title={Cited duplicate}}\n");
    expect(deleteUnusedReferences(dir)).toHaveLength(2);
    expect(read("refs.bib")).toContain("% Preserve this comment\n@misc{keep,title={Keep}}");
    expect(read("other.bib")).toContain("@misc{keep,title={Cited duplicate}}");
    expect(read("refs.bib")).not.toContain("@misc{unused");
    expect(deleteUnusedReferences(dir)).toEqual([]);
  });
  it("rechecks current source instead of deleting stale candidates", () => {
    expect(unusedReferenceEntries(dir)).toHaveLength(1);
    write("main.tex", "\\cite{keep,unused}");
    expect(deleteUnusedReferences(dir)).toEqual([]);
  });
  it("preserves explicit nocite and wildcard inclusions", () => {
    write("main.tex", "\\cite{keep}\\nocite{unused}");
    expect(deleteUnusedReferences(dir)).toEqual([]);
    write("main.tex", "\\nocite{*}");
    expect(deleteUnusedReferences(dir)).toEqual([]);
  });
  it("ignores commented citations and commented wildcard inclusions", () => {
    write("main.tex", "\\cite{keep} % \\nocite{*}\n% \\cite{unused}");
    expect(deleteUnusedReferences(dir).map(e => e.key)).toEqual(["unused"]);
  });
  it("keeps transitive and cyclic bibliography dependencies and string definitions", () => {
    write("refs.bib", '@string{venue = "Conference"}\n@misc{keep,crossref={parent}}\n@proceedings{parent,xdata={data}}\n@xdata{data,xref={parent}}\n@misc{unused,title={Remove}}');
    expect(deleteUnusedReferences(dir).map(e => e.key)).toEqual(["unused"]);
    expect(read("refs.bib")).toContain('@string{venue = "Conference"}');
    expect(read("refs.bib")).toContain("@proceedings{parent");
    expect(read("refs.bib")).toContain("@xdata{data");
  });
});
