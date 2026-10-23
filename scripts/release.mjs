#!/usr/bin/env node
/**
 * Prepare a release locally: version bump, CHANGELOG heading, commit, tag.
 *   npm run release -- 0.5.0 [--dry-run]
 *
 * Checks that the tree is clean, on main, that the version is newer than
 * server/package.json's (the published package) and that CHANGELOG.md has a
 * non-empty "## Unreleased" section. Then it sets the version in the root,
 * server and web package.json files and package-lock.json, renames
 * "## Unreleased" to "## <version> — <date>" under a fresh empty
 * "## Unreleased", commits, and creates an annotated tag v<version>.
 *
 * It never pushes or publishes. --dry-run runs the checks and prints the
 * plan without writing anything.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: npm run release -- <version> [--dry-run]   (e.g. 0.5.0 or 0.5.0-rc.1)";

function die(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const unknown = argv.filter((a) => a.startsWith("-") && a !== "--dry-run");
const positional = argv.filter((a) => !a.startsWith("-"));
if (unknown.length > 0) die(`unknown option ${unknown[0]}\n${USAGE}`);
if (positional.length !== 1) die(USAGE);
const version = positional[0].replace(/^v/, "");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
if (!SEMVER.test(version)) die(`"${positional[0]}" is not a version like 1.2.3 or 1.2.3-rc.1`);

/** Semver precedence: <0, 0 or >0 (build metadata is not supported). */
function compareVersions(a, b) {
  const [, ...pa] = a.match(SEMVER);
  const [, ...pb] = b.match(SEMVER);
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (!pa[3] || !pb[3]) return (pa[3] ? -1 : 0) + (pb[3] ? 1 : 0); // a release outranks its prereleases
  const xa = pa[3].split(".");
  const xb = pb[3].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// ---- checks ---------------------------------------------------------------

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") die(`releases are cut from main, but the current branch is ${branch}`);
const dirty = git("status", "--porcelain");
if (dirty) die(`the working tree is not clean:\n${dirty}`);
const tag = `v${version}`;
if (git("tag", "--list", tag)) die(`tag ${tag} already exists`);

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const current = readJson("server/package.json").version;
if (compareVersions(version, current) <= 0) die(`${version} is not newer than the current version ${current}`);

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((l) => /^## Unreleased\s*$/.test(l));
if (start < 0) die('CHANGELOG.md has no "## Unreleased" section');
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join("\n").trim();
if (!notes) die('the "## Unreleased" section of CHANGELOG.md is empty; describe the release first');

// ---- plan -----------------------------------------------------------------

const now = new Date();
const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
const heading = `## ${version} — ${date}`;
const nextChangelog = [...lines.slice(0, start), "## Unreleased", "", heading, ...lines.slice(start + 1)].join("\n");

const writes = new Map(); // relative path → new contents
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
for (const rel of ["package.json", "server/package.json", "web/package.json"]) {
  const pkg = readJson(rel);
  console.log(`${rel.padEnd(20)} ${pkg.version} → ${version}`);
  pkg.version = version;
  writes.set(rel, json(pkg));
}
const lock = readJson("package-lock.json");
lock.version = version;
for (const key of ["", "server", "web"]) {
  if (lock.packages?.[key]) lock.packages[key].version = version;
}
writes.set("package-lock.json", json(lock));
console.log(`${"package-lock.json".padEnd(20)} workspace versions → ${version}`);
writes.set("CHANGELOG.md", nextChangelog);
console.log(`${"CHANGELOG.md".padEnd(20)} "## Unreleased" → "${heading}" (${notes.split("\n").filter((l) => l.startsWith("- ")).length} entries), new empty "## Unreleased" above`);
console.log(`commit               Release ${version}`);
console.log(`tag                  ${tag} (annotated)`);

if (dryRun) {
  console.log("\nDry run: nothing was written, committed or tagged.");
  process.exit(0);
}

// ---- apply ----------------------------------------------------------------

for (const [rel, contents] of writes) writeFileSync(join(root, rel), contents);
git("add", "--", ...writes.keys());
git("commit", "--quiet", "-m", `Release ${version}`);
git("tag", "-a", tag, "-m", `BlattBot ${version}`);

console.log(`
Created the release commit and tag ${tag}. Nothing was pushed or published.
Review it with \`git show ${tag}\`, then push both:
  git push origin main ${tag}
The tag starts the Release workflow (full CI matrix, then a GitHub Release
with the npm tarball attached). Publishing to npm stays manual, see
.github/workflows/release.yml.`);
