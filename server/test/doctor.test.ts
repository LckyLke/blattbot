import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-doctor-test-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  vi.stubEnv("BLATTBOT_DATA_DIR", join(dir, "data"));
  vi.stubEnv("BLATTBOT_HOME", join(dir, "home")); // no real browser profiles
  vi.stubEnv("BLATTBOT_WSL", "0");
  vi.stubEnv("BLATTBOT_CODEX_EXECUTABLE", join(dir, "no-such-codex"));
  vi.stubEnv("PATH", bin); // nothing but what a test puts there
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A fake command on PATH that prints `line` for any arguments. */
function fakeCommand(name: string, line: string) {
  if (process.platform === "win32") writeFileSync(join(bin, `${name}.cmd`), `@echo ${line}\r\n`);
  else writeFileSync(join(bin, name), `#!/bin/sh\necho "${line}"\n`, { mode: 0o755 });
}

async function doctor() {
  const lines: string[] = [];
  const { runDoctor } = await import("../src/doctor.js");
  const result = await runDoctor((line) => lines.push(line));
  return { ...result, output: lines.join("\n") };
}

describe("runDoctor", () => {
  it("fails when git is missing and only warns about optional tools", async () => {
    const { failures, warnings, output } = await doctor();
    expect(failures).toEqual(["git"]);
    expect(warnings).toEqual(expect.arrayContaining(["tar", "TeX engine", "Codex", "Poppler", "Tesseract"]));
    expect(output).toContain("git:       NOT FOUND — required");
    expect(output).toContain("Missing required: git.");
    expect(output).toMatch(/Codex:\s+not available/);
  });

  it("passes with git present even when every optional tool is missing", async () => {
    fakeCommand("git", "git version 9.9.9");
    fakeCommand("tar", "bsdtar 3.7.2");
    const { failures, warnings, output } = await doctor();
    expect(failures).toEqual([]);
    expect(warnings).not.toContain("tar");
    expect(output).toContain("git:       git version 9.9.9");
    expect(output).toContain("tar:       bsdtar 3.7.2");
    expect(output).toContain("Required tools: all found.");
  });
});
