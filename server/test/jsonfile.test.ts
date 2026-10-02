import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../src/jsonfile.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "blattbot-jsonfile-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("round-trips through a temp file, leaving nothing else behind", () => {
  const path = join(dir, "projects.json");
  writeJsonFile(path, [{ id: "a" }]);
  writeJsonFile(path, [{ id: "a" }, { id: "b" }]);
  expect(readJsonFile(path, [])).toEqual([{ id: "a" }, { id: "b" }]);
  expect(readdirSync(dir)).toEqual(["projects.json"]);
});

it("returns the fallback for a missing file", () => {
  expect(readJsonFile(join(dir, "missing.json"), { fresh: true })).toEqual({ fresh: true });
});

it("keeps a copy of an unparsable file instead of letting the next save erase it", () => {
  const path = join(dir, "accounts.json");
  writeFileSync(path, '[{"id": "uni", "cookie": "overleaf.sid=…"');
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(readJsonFile(path, [])).toEqual([]);
  const aside = readdirSync(dir).find((f) => f.startsWith("accounts.json.corrupt-"));
  expect(aside).toBeDefined();
  expect(readFileSync(join(dir, aside!), "utf8")).toContain('"id": "uni"');
  expect(log).toHaveBeenCalledWith(expect.stringContaining(aside!));
  writeJsonFile(path, []);
  expect(readFileSync(join(dir, aside!), "utf8")).toContain('"id": "uni"');
});
