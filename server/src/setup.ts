/**
 * First-run bootstrap: download a tectonic release binary into DATA_DIR/bin.
 *
 * URL construction is a pure function (unit-tested); the installer downloads
 * the archive, unpacks it by shelling out to the system `tar` (present on
 * Linux, macOS, and Windows 10+, where bsdtar also reads .zip), marks the
 * binary executable, and verifies `tectonic --version` actually runs before
 * moving it into place.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

export const TECTONIC_VERSION = "0.15.0";

/** Release-asset target triples per Node platform-arch, in fallback order.
 *  linux-x64 prefers the gnu build and falls back to the static musl one;
 *  linux-arm64 only ships as musl. */
const TRIPLES: Record<string, string[]> = {
  "linux-x64": ["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"],
  "linux-arm64": ["aarch64-unknown-linux-musl"],
  "darwin-x64": ["x86_64-apple-darwin"],
  "darwin-arm64": ["aarch64-apple-darwin"],
  "win32-x64": ["x86_64-pc-windows-msvc"],
};

function assetName(triple: string): string {
  const ext = triple.includes("windows") ? "zip" : "tar.gz";
  return `tectonic-${TECTONIC_VERSION}-${triple}.${ext}`;
}

/** All download candidates for a platform/arch, in order of preference. */
export function tectonicAssetCandidates(platform: string, arch: string): string[] {
  const triples = TRIPLES[`${platform}-${arch}`] ?? [];
  return triples.map(
    (t) =>
      `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${assetName(t)}`,
  );
}

/** The primary release-asset URL for a platform/arch, or null when unsupported. */
export function tectonicAssetUrl(platform: string, arch: string): string | null {
  return tectonicAssetCandidates(platform, arch)[0] ?? null;
}

/** Find a file by name anywhere under `dir` (release archives may nest). */
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === name && statSync(p).isFile()) return p;
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

export async function installTectonic(
  binDir: string,
  opts: { platform?: string; arch?: string; log?: (line: string) => void } = {},
): Promise<{ path: string; version: string }> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const log = opts.log ?? (() => {});
  const candidates = tectonicAssetCandidates(platform, arch);
  if (candidates.length === 0) {
    throw new Error(`no prebuilt tectonic for ${platform}/${arch} — install it manually`);
  }

  const work = mkdtempSync(join(tmpdir(), "blattbot-tectonic-"));
  try {
    // Download the first candidate that exists (gnu → musl fallback on linux).
    let archive: string | null = null;
    let lastError = "";
    for (const url of candidates) {
      log(`downloading ${url}`);
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err: any) {
        lastError = `${url}: ${err?.message ?? err}`;
        continue;
      }
      if (!res.ok) {
        lastError = `${url}: HTTP ${res.status}`;
        continue;
      }
      archive = join(work, url.split("/").pop()!);
      writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      break;
    }
    if (!archive) throw new Error(`download failed (${lastError})`);

    // System tar handles .tar.gz everywhere; on Windows 10+ bsdtar reads .zip too.
    await execFileP("tar", ["-xf", archive, "-C", work], { timeout: 120_000 });
    rmSync(archive, { force: true });

    const exe = platform === "win32" ? "tectonic.exe" : "tectonic";
    const unpacked = findFile(work, exe);
    if (!unpacked) throw new Error(`archive did not contain ${exe}`);
    chmodSync(unpacked, 0o755);

    // Prove the binary actually runs on this machine before installing it.
    // (tectonic prints its version twice without a separator — normalize.)
    const { stdout } = await execFileP(unpacked, ["--version"], { timeout: 30_000 });
    const versionNumber = stdout.match(/\d+(\.\d+)+/)?.[0];
    const version = versionNumber ? `tectonic ${versionNumber}` : stdout.trim() || "tectonic (version unknown)";

    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, exe);
    copyFileSync(unpacked, dest); // copy, not rename — the temp dir may be another filesystem
    chmodSync(dest, 0o755);
    log(`installed ${version} → ${dest}`);
    return { path: dest, version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
