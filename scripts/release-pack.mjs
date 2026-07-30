#!/usr/bin/env node
/**
 * Build the publishable `blattbot` npm package:
 *   1. build the web UI and copy it into server/web-dist (bundled with the package)
 *   2. copy README.md + LICENSE into server/ (npm packs from the workspace dir)
 *   3. compile the server to server/dist
 *   4. `npm pack` the server workspace → blattbot-<version>.tgz in the repo root
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

run("npm", ["run", "build", "--workspace=web"]);

rmSync(join(root, "server", "web-dist"), { recursive: true, force: true });
cpSync(join(root, "web", "dist"), join(root, "server", "web-dist"), { recursive: true });
copyFileSync(join(root, "README.md"), join(root, "server", "README.md"));
copyFileSync(join(root, "LICENSE"), join(root, "server", "LICENSE"));

rmSync(join(root, "server", "dist"), { recursive: true, force: true });
run("npm", ["run", "build", "--workspace=server"]);

run("npm", ["pack", "--workspace=server", "--pack-destination", root]);
console.log("\nrelease:pack done — tarball is in the repo root.");
