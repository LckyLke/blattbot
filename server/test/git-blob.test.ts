import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { blobId } from "../src/git.js";

it("hashes contents exactly like git hash-object", () => {
  for (const content of [Buffer.alloc(0), Buffer.from("\\section{Intro}\nText.\n"), Buffer.from([0, 255, 13, 10])]) {
    expect(blobId(content)).toBe(execFileSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" }).trim());
  }
});
