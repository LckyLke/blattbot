#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for one version, for GitHub Release notes:
 *   node scripts/release-notes.mjs [v]0.4.2
 * Without an argument, the server package's current version is used.
 * Exits 1 when the changelog has no such section.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version =
  process.argv[2]?.replace(/^v/, "") ??
  JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version;

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`);
const start = lines.findIndex((l) => heading.test(l));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
process.stdout.write(lines.slice(start + 1, end).join("\n").trim() + "\n");
