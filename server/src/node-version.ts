/**
 * The oldest Node.js BlattBot runs on. Browser cookie discovery uses
 * node:sqlite, which works without a flag from 22.13 on the 22.x line and
 * from 23.4 on 23.x. Keep in sync with "engines" in server/package.json.
 *
 * No imports on purpose: the CLI loads this before anything that would
 * crash on an older Node, so it can print a clear message instead.
 */
export const MIN_NODE = "22.13.0";

/** True when `version` (e.g. "22.13.0" or "v24.1.0") can run BlattBot. */
export function nodeSupported(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}
