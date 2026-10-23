/**
 * Run the browser verify scripts that need no real model and no TeX engine,
 * one after another, each against its own isolated server and data dir:
 *   npm run build --workspace=web
 *   npm run verify:ui                       # all of them
 *   npm run verify:ui -- sync-ui refs-cleanup-ui   # a subset
 * Set BLATTBOT_BROWSER_EXECUTABLE when Chrome/Chromium is not at
 * /usr/bin/chromium or /usr/bin/google-chrome.
 *
 * Not included: ui-verify.ts (compiles real LaTeX; `npm run test:ui`),
 * e2e*.ts and ui-e2e.ts (real agent turns against a running server).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = [
  "chat-effort-ui",
  "code-repositories-ui",
  "file-mentions-ui",
  "graph-explorer",
  "history-ui",
  "pdf-links-ui",
  "refs-cleanup-ui",
  "research-ui",
  "sidebar-ui",
  "sync-ui",
  "turn-flow-ui",
];

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(serverDir, "..", "web", "dist", "index.html"))) {
  console.error("verify:ui: web/dist is missing. Build the app first: npm run build --workspace=web");
  process.exit(1);
}

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !SCRIPTS.includes(name));
if (unknown.length > 0) {
  console.error(`verify:ui: unknown script ${unknown.join(", ")}. Choose from: ${SCRIPTS.join(", ")}`);
  process.exit(1);
}

const results: { name: string; ok: boolean; seconds: number }[] = [];
for (const name of requested.length > 0 ? requested : SCRIPTS) {
  console.log(`\n▶ ${name}-verify`);
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", join("scripts", `${name}-verify.ts`)], {
    cwd: serverDir,
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  results.push({ name, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\nverify:ui summary");
for (const r of results) console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(22)} ${r.seconds}s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
