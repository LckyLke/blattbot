/**
 * Cross-browser, cross-platform cookie discovery.
 *
 * Enumerates the cookie stores of installed browsers (Firefox family +
 * Chromium family) for the current OS, and reads a named cookie for a host.
 * Firefox stores values in plaintext; Chromium encrypts them — the per-OS key
 * acquisition lives here, the decryption math in chromium-crypto.ts.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decryptChromiumCookie,
  deriveCbcKey,
  LINUX_FALLBACK_KEY,
} from "./chromium-crypto.js";

export type Family = "firefox" | "chromium";

export interface BrowserProfile {
  browser: string;
  family: Family;
  /** Path to cookies.sqlite (firefox) or Cookies (chromium). */
  cookieDb: string;
  /** Chromium only: path to the "Local State" file (holds the encrypted key on Windows). */
  localState?: string;
  /** Chromium only: keyring/keychain service name used for the storage secret. */
  safeStorageService?: string;
}

function homeDir(): string {
  return process.env.BLATTBOT_HOME ?? homedir();
}

/** Directories to probe per platform, as {browser, family, relative dir, service}. */
interface Spec {
  browser: string;
  family: Family;
  dirs: string[];
  service?: string;
}

function specsForPlatform(): Spec[] {
  const home = homeDir();
  const p = platform();
  if (p === "darwin") {
    const app = join(home, "Library", "Application Support");
    return [
      { browser: "Firefox", family: "firefox", dirs: [join(home, "Library", "Application Support", "Firefox", "Profiles")] },
      { browser: "Chrome", family: "chromium", dirs: [join(app, "Google", "Chrome")], service: "Chrome Safe Storage" },
      { browser: "Chromium", family: "chromium", dirs: [join(app, "Chromium")], service: "Chromium Safe Storage" },
      { browser: "Edge", family: "chromium", dirs: [join(app, "Microsoft Edge")], service: "Microsoft Edge Safe Storage" },
      { browser: "Brave", family: "chromium", dirs: [join(app, "BraveSoftware", "Brave-Browser")], service: "Brave Safe Storage" },
      { browser: "Vivaldi", family: "chromium", dirs: [join(app, "Vivaldi")], service: "Vivaldi Safe Storage" },
    ];
  }
  if (p === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      { browser: "Firefox", family: "firefox", dirs: [join(roaming, "Mozilla", "Firefox", "Profiles")] },
      { browser: "Chrome", family: "chromium", dirs: [join(local, "Google", "Chrome", "User Data")] },
      { browser: "Edge", family: "chromium", dirs: [join(local, "Microsoft", "Edge", "User Data")] },
      { browser: "Brave", family: "chromium", dirs: [join(local, "BraveSoftware", "Brave-Browser", "User Data")] },
      { browser: "Vivaldi", family: "chromium", dirs: [join(local, "Vivaldi", "User Data")] },
    ];
  }
  // Linux / other unix
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    { browser: "Firefox", family: "firefox", dirs: [join(home, ".mozilla", "firefox")] },
    { browser: "Chrome", family: "chromium", dirs: [join(config, "google-chrome")], service: "Chrome Safe Storage" },
    { browser: "Chromium", family: "chromium", dirs: [join(config, "chromium")], service: "Chromium Safe Storage" },
    { browser: "Edge", family: "chromium", dirs: [join(config, "microsoft-edge")], service: "Microsoft Edge Safe Storage" },
    { browser: "Brave", family: "chromium", dirs: [join(config, "BraveSoftware", "Brave-Browser")], service: "Brave Safe Storage" },
    { browser: "Vivaldi", family: "chromium", dirs: [join(config, "vivaldi")], service: "Vivaldi Safe Storage" },
  ];
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

/** Chromium profile subdirs that hold a Cookies db (Default, Profile 1, …). */
function chromiumCookieDbs(userDataDir: string): { profile: string; db: string }[] {
  const out: { profile: string; db: string }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(userDataDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name !== "Default" && !name.startsWith("Profile ")) continue;
    // Chromium moved the db under Network/ around v96.
    const db =
      firstExisting([
        join(userDataDir, name, "Network", "Cookies"),
        join(userDataDir, name, "Cookies"),
      ]);
    if (db) out.push({ profile: name, db });
  }
  return out;
}

/** Enumerate every browser profile with a cookie store on this machine. */
export function discoverProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  for (const spec of specsForPlatform()) {
    const root = firstExisting(spec.dirs);
    if (!root) continue;
    if (spec.family === "firefox") {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(root).filter((d) => existsSync(join(root, d, "cookies.sqlite")));
      } catch {
        /* none */
      }
      for (const d of dirs) {
        profiles.push({ browser: spec.browser, family: "firefox", cookieDb: join(root, d, "cookies.sqlite") });
      }
    } else {
      const localState = firstExisting([join(root, "Local State")]);
      for (const { db } of chromiumCookieDbs(root)) {
        profiles.push({
          browser: spec.browser,
          family: "chromium",
          cookieDb: db,
          localState,
          safeStorageService: spec.service,
        });
      }
    }
  }
  return profiles;
}

export interface CookieRow {
  name: string;
  value: string;
  lastAccess: number;
}

/** Copy a sqlite db (browsers keep it locked/WAL) and open it read-only. */
function openCopied<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "blattbot-cookies-"));
  try {
    const copy = join(tmp, "db.sqlite");
    copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Cookie-store host keys a browser would send to `host`: the host itself plus
 * every parent-domain cookie down to the registrable domain. A session for
 * www.overleaf.com typically lives under ".overleaf.com".
 */
export function cookieHostKeys(host: string): string[] {
  const keys = [host, `.${host}`];
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) keys.push("." + parts.slice(i).join("."));
  return [...new Set(keys)];
}

/** Read named cookies for a host from a Firefox cookies.sqlite. */
export function readFirefox(dbPath: string, host: string, names: string[]): CookieRow[] {
  return openCopied(dbPath, (db) => {
    const hosts = cookieHostKeys(host);
    const hp = hosts.map(() => "?").join(",");
    const ph = names.map(() => "?").join(",");
    return (
      db
        .prepare(
          `SELECT name, value, lastAccessed FROM moz_cookies
           WHERE host IN (${hp}) AND name IN (${ph})`,
        )
        .all(...hosts, ...names) as any[]
    ).map((r) => ({ name: String(r.name), value: String(r.value), lastAccess: Number(r.lastAccessed) }));
  });
}

/** Fetch the OS storage secret for a Chromium browser (Linux/macOS keyring). */
function chromiumStorageSecret(service?: string): string {
  const p = platform();
  if (p === "linux" && service) {
    try {
      const out = execFileSync("secret-tool", ["lookup", "application", service.replace(/ Safe Storage$/, "").toLowerCase()], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      /* keyring locked or absent */
    }
    // Common Linux fallback secret when the keyring is unavailable ("basic" storage).
    return "peanuts";
  }
  if (p === "darwin" && service) {
    try {
      return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* not in keychain */
    }
  }
  return "peanuts";
}

/** Windows: decrypt the AES-256-GCM key stored (DPAPI-wrapped) in Local State. */
function windowsGcmKey(localStatePath?: string): Buffer | null {
  if (!localStatePath || !existsSync(localStatePath) || platform() !== "win32") return null;
  try {
    const state = JSON.parse(readFileSync(localStatePath, "utf8"));
    const b64 = state?.os_crypt?.encrypted_key;
    if (!b64) return null;
    let wrapped = Buffer.from(b64, "base64");
    if (wrapped.subarray(0, 5).toString("ascii") === "DPAPI") wrapped = wrapped.subarray(5);
    // Unwrap via PowerShell's ProtectedData (no native module needed).
    const b64wrapped = wrapped.toString("base64");
    const ps =
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(` +
      `[Convert]::FromBase64String('${b64wrapped}'),$null,'CurrentUser'))`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Buffer.from(out, "base64");
  } catch {
    return null;
  }
}

/** Read + decrypt named cookies for a host from a Chromium Cookies db. */
export function readChromium(profile: BrowserProfile, host: string, names: string[]): CookieRow[] {
  const isWin = platform() === "win32";
  const cbcKey = isWin
    ? undefined
    : platform() === "darwin"
      ? deriveCbcKey(chromiumStorageSecret(profile.safeStorageService), 1003)
      : (() => {
          const secret = chromiumStorageSecret(profile.safeStorageService);
          return secret === "peanuts" ? LINUX_FALLBACK_KEY : deriveCbcKey(secret, 1);
        })();
  const gcmKey = isWin ? windowsGcmKey(profile.localState) ?? undefined : undefined;

  return openCopied(profile.cookieDb, (db) => {
    const hosts = cookieHostKeys(host);
    const hp = hosts.map(() => "?").join(",");
    const ph = names.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT name, encrypted_value, value, last_access_utc FROM cookies
         WHERE host_key IN (${hp}) AND name IN (${ph})`,
      )
      .all(...hosts, ...names) as any[];
    const out: CookieRow[] = [];
    for (const r of rows) {
      let value = "";
      const enc = r.encrypted_value as Buffer | Uint8Array | null;
      if (enc && enc.length > 0) {
        try {
          value = decryptChromiumCookie(Buffer.from(enc), { cbcKey, gcmKey, stripDomainHash: true }) ?? "";
        } catch {
          value = "";
        }
      } else if (typeof r.value === "string") {
        value = r.value;
      }
      if (value) out.push({ name: String(r.name), value, lastAccess: Number(r.last_access_utc) });
    }
    return out;
  });
}
