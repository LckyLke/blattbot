import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE, nodeSupported } from "../src/node-version.js";

describe("nodeSupported", () => {
  it("accepts the releases with node:sqlite unflagged", () => {
    for (const v of ["22.13.0", "v22.13.0", "22.22.0", "23.4.0", "23.11.1", "24.0.0", "26.1.0"]) {
      expect(nodeSupported(v), v).toBe(true);
    }
  });

  it("rejects older releases", () => {
    for (const v of ["18.20.4", "20.20.2", "21.7.3", "22.12.0", "v22.5.1", "23.3.0"]) {
      expect(nodeSupported(v), v).toBe(false);
    }
  });

  it("matches the engines field of the published package", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(`^${MIN_NODE} || >=23.4.0`);
    expect(nodeSupported(MIN_NODE)).toBe(true);
  });

  it("holds for the Node running the tests", () => {
    expect(nodeSupported()).toBe(true);
  });
});
