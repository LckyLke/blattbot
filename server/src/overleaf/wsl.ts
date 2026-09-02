/**
 * Windows Subsystem for Linux: the server runs as Linux, but the user's
 * browsers (and their cookie stores) live on the Windows side, mounted under
 * /mnt/<drive>. This module finds those Windows user homes and executables,
 * and opens a URL in the Windows default browser through WSL interop.
 *
 * Test hooks: BLATTBOT_WSL=1|0 forces detection, BLATTBOT_WSL_MNT replaces
 * /mnt as the drive-mount root.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

/** True when this Linux process runs inside WSL (1 or 2). */
export function isWsl(): boolean {
  const forced = process.env.BLATTBOT_WSL;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (platform() !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function mountRoot(): string {
  return process.env.BLATTBOT_WSL_MNT || "/mnt";
}

/** Mounted Windows drives (/mnt/c, /mnt/d, …), system drive first. */
export function windowsDrives(): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(mountRoot()).filter((n) => /^[a-z]$/i.test(n));
  } catch {
    return [];
  }
  const drives = names.map((n) => join(mountRoot(), n)).filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  return drives.sort((a, b) => Number(hasWindowsDir(b)) - Number(hasWindowsDir(a)));
}

function hasWindowsDir(drive: string): boolean {
  return existsSync(join(drive, "Windows", "System32"));
}

/** Directories that Windows keeps under Users\ but that are not user homes. */
const NOT_A_USER = new Set(["public", "default", "default user", "all users", "desktop.ini"]);

/**
 * Windows user profile directories reachable from WSL (the ones with an
 * AppData folder). Other users' homes are normally unreadable and simply
 * yield nothing later; the current user's is what we are after.
 */
export function windowsUserHomes(): string[] {
  const homes: string[] = [];
  for (const drive of windowsDrives()) {
    const users = join(drive, "Users");
    let entries: string[] = [];
    try {
      entries = readdirSync(users);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (NOT_A_USER.has(name.toLowerCase())) continue;
      const home = join(users, name);
      if (existsSync(join(home, "AppData"))) homes.push(home);
    }
  }
  return homes;
}

/** Absolute WSL path of a Windows system executable (relative to System32), or null. */
export function windowsExe(relative: string): string | null {
  for (const drive of windowsDrives()) {
    const p = join(drive, "Windows", "System32", relative);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Run a Windows executable through interop and return its stdout. */
export function runWindowsExe(relative: string, args: string[], timeoutMs = 15_000): string {
  const exe = windowsExe(relative);
  if (!exe) throw new Error(`${relative} not found under any mounted Windows drive`);
  const res = spawnSync(exe, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    // A Linux-side cwd makes cmd.exe complain about UNC paths; start on the drive.
    cwd: windowsDrives()[0],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${relative} exited with ${res.status}`);
  return res.stdout;
}

/**
 * Open a URL in the Windows default browser. Tries wslu's wslview (honours the
 * user's setup), then rundll32's URL handler, then `cmd /c start`.
 */
export function openInWindowsBrowser(url: string): boolean {
  const attempts: { bin: string | null; args: string[] }[] = [
    { bin: "wslview", args: [url] },
    { bin: windowsExe("rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] },
    { bin: windowsExe("cmd.exe"), args: ["/c", "start", "", url] },
  ];
  for (const { bin, args } of attempts) {
    if (!bin) continue;
    const res = spawnSync(bin, args, { stdio: "ignore", timeout: 10_000, cwd: windowsDrives()[0] });
    // explorer-style launchers return odd exit codes; only a failed spawn counts.
    if (!res.error) return true;
  }
  return false;
}
