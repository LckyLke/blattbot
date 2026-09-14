import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationPassages, unreadCitationChanges } from "../src/sourcecoverage.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "blattbot-coverage-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("citation source coverage", () => {
  it("ignores unchanged passages and catches new claims even with existing cite keys", () => {
    writeFileSync(join(dir, "main.tex"), "Original statement \\cite{known}.\n\nOther text.");
    const before = citationPassages(dir);
    writeFileSync(join(dir, "main.tex"), "Original statement \\cite{known}.\n\nA new comparison \\cite{known, new}.\n");
    const after = citationPassages(dir);
    expect(unreadCitationChanges(before, after, new Set())).toEqual(["known", "new"]);
    expect(unreadCitationChanges(before, after, new Set(["known"]))).toEqual(["new"]);
    expect(unreadCitationChanges(after, after, new Set())).toEqual([]);
  });

  it("does not lose edits beyond the verifier's claim-length limit", () => {
    const prefix = "Background ".repeat(250);
    writeFileSync(join(dir, "main.tex"), `${prefix}Old result \\cite{a}.`);
    const before = citationPassages(dir);
    writeFileSync(join(dir, "main.tex"), `${prefix}New result \\cite{a}.`);
    expect(unreadCitationChanges(before, citationPassages(dir), new Set())).toEqual(["a"]);
  });
});
