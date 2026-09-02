import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SCOPE_FILES, validateScope } from "../src/agent.js";

describe("validateScope", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "blattbot-scope-"));
    writeFileSync(join(dir, "main.tex"), "x");
    mkdirSync(join(dir, "sections"), { recursive: true });
    writeFileSync(join(dir, "sections/intro.tex"), "x");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("accepts existing relative files and dedupes", () => {
    expect(validateScope(dir, ["main.tex", "sections/intro.tex", "main.tex"])).toEqual([
      "main.tex",
      "sections/intro.tex",
    ]);
  });

  it("returns empty for an empty list", () => {
    expect(validateScope(dir, [])).toEqual([]);
  });

  it("rejects non-arrays and non-string entries", () => {
    expect(() => validateScope(dir, "main.tex")).toThrow(/array/);
    expect(() => validateScope(dir, [42])).toThrow(/array of strings/);
  });

  it("rejects paths escaping the project", () => {
    expect(() => validateScope(dir, ["../evil.tex"])).toThrow(/invalid scope path/);
    expect(() => validateScope(dir, ["/etc/passwd"])).toThrow(/invalid scope path/);
    expect(() => validateScope(dir, ["sections/../../evil.tex"])).toThrow(/invalid scope path/);
  });

  it("rejects missing files and directories", () => {
    expect(() => validateScope(dir, ["ghost.tex"])).toThrow(/does not exist/);
    expect(() => validateScope(dir, ["sections"])).toThrow(/does not exist/);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: MAX_SCOPE_FILES + 1 }, (_, i) => `f${i}.tex`);
    expect(() => validateScope(dir, many)).toThrow(/limit/);
  });
});

describe("resolveModel", () => {
  it("defaults to the newest Sonnet and maps tier aliases to Claude 5 ids", async () => {
    const { resolveModel, DEFAULT_MODEL } = await import("../src/agent.js");
    expect(resolveModel("")).toBe(DEFAULT_MODEL);
    expect(resolveModel("  ")).toBe("claude-sonnet-5");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel("Opus")).toBe("claude-opus-5");
    expect(resolveModel("fable")).toBe("claude-fable-5-1");
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("claude-opus-4-6")).toBe("claude-opus-4-6"); // explicit ids pass through
  });
});
