/**
 * Durable JSON files for BlattBot's own state (projects, accounts, settings,
 * chat lists). A write goes to a temp file that is renamed over the target, so
 * a crash mid-write leaves the previous version intact. A file that exists but
 * does not parse is moved aside and logged — never read as "empty" and then
 * silently replaced by the next save, which would lose every entry in it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (err: any) {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/:/g, "-")}`;
    // If even the backup fails, refuse: losing the file is worse than an error.
    writeFileSync(aside, text, { mode: 0o600 });
    console.error(`BlattBot: ${path} could not be parsed (${err?.message ?? err}); kept a copy at ${aside} and started fresh.`);
    return fallback;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
