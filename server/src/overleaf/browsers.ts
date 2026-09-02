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
import { isWsl, windowsExe, windowsUserHomes } from "./wsl.js";

export type Family = "firefox" | "chromium";
/** Which OS wrote a cookie store — decides the Chromium decryption scheme. */
export type Crypt = "linux" | "darwin" | "windows";

export interface BrowserProfile {
  browser: string;
  family: Family;
  /** Path to cookies.sqlite (firefox) or Cookies (chromium). */
  cookieDb: string;
  /** Chromium only: path to the "Local State" file (holds the encrypted key on Windows). */
  localState?: string;
  /** Chromium only: keyring/keychain service name used for the storage secret. */
  safeStorageService?: string;
  /**
   * The OS that wrote the store. Usually the current platform; under WSL the
   * Windows browsers' stores are read from /mnt/<drive> with Windows crypto.
   */
  crypt: Crypt;
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
  crypt: Crypt;
}

/**
 * The Windows browser stores under one user profile. `label` suffixes the
 * browser name ("Firefox (Windows)") when the store is read from WSL.
 */
function windowsSpecs(local: string, roaming: string, label = ""): Spec[] {
  const crypt: Crypt = "windows";
  return [
    { browser: `Firefox${label}`, family: "firefox", dirs: [join(roaming, "Mozilla", "Firefox", "Profiles")], crypt },
    { browser: `Chrome${label}`, family: "chromium", dirs: [join(local, "Google", "Chrome", "User Data")], crypt },
    { browser: `Chromium${label}`, family: "chromium", dirs: [join(local, "Chromium", "User Data")], crypt },
    { browser: `Edge${label}`, family: "chromium", dirs: [join(local, "Microsoft", "Edge", "User Data")], crypt },
    { browser: `Brave${label}`, family: "chromium", dirs: [join(local, "BraveSoftware", "Brave-Browser", "User Data")], crypt },
    { browser: `Vivaldi${label}`, family: "chromium", dirs: [join(local, "Vivaldi", "User Data")], crypt },
  ];
}

function specsForPlatform(): Spec[] {
  const home = homeDir();
  const p = platform();
  if (p === "darwin") {
    const app = join(home, "Library", "Application Support");
    const crypt: Crypt = "darwin";
    return [
      { browser: "Firefox", family: "firefox", dirs: [join(home, "Library", "Application Support", "Firefox", "Profiles")], crypt },
      { browser: "Chrome", family: "chromium", dirs: [join(app, "Google", "Chrome")], service: "Chrome Safe Storage", crypt },
      { browser: "Chromium", family: "chromium", dirs: [join(app, "Chromium")], service: "Chromium Safe Storage", crypt },
      { browser: "Edge", family: "chromium", dirs: [join(app, "Microsoft Edge")], service: "Microsoft Edge Safe Storage", crypt },
      { browser: "Brave", family: "chromium", dirs: [join(app, "BraveSoftware", "Brave-Browser")], service: "Brave Safe Storage", crypt },
      { browser: "Vivaldi", family: "chromium", dirs: [join(app, "Vivaldi")], service: "Vivaldi Safe Storage", crypt },
    ];
  }
  if (p === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return windowsSpecs(local, roaming);
  }
  // Linux / other unix
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const crypt: Crypt = "linux";
  const specs: Spec[] = [
    { browser: "Firefox", family: "firefox", dirs: [join(home, ".mozilla", "firefox")], crypt },
    { browser: "Chrome", family: "chromium", dirs: [join(config, "google-chrome")], service: "Chrome Safe Storage", crypt },
    { browser: "Chromium", family: "chromium", dirs: [join(config, "chromium")], service: "Chromium Safe Storage", crypt },
    { browser: "Edge", family: "chromium", dirs: [join(config, "microsoft-edge")], service: "Microsoft Edge Safe Storage", crypt },
    { browser: "Brave", family: "chromium", dirs: [join(config, "BraveSoftware", "Brave-Browser")], service: "Brave Safe Storage", crypt },
    { browser: "Vivaldi", family: "chromium", dirs: [join(config, "vivaldi")], service: "Vivaldi Safe Storage", crypt },
  ];
  // Under WSL the browsers the user actually logs in with are the Windows
  // ones; their stores sit under /mnt/<drive>/Users/<name>/AppData.
  if (isWsl()) {
    for (const winHome of windowsUserHomes()) {
      specs.push(
        ...windowsSpecs(join(winHome, "AppData", "Local"), join(winHome, "AppData", "Roaming"), " (Windows)"),
      );
    }
  }
  return specs;
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
        profiles.push({
          browser: spec.browser,
          family: "firefox",
          cookieDb: join(root, d, "cookies.sqlite"),
          crypt: spec.crypt,
        });
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
          crypt: spec.crypt,
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
  /** The cookie exists but its value could not be decrypted (value is ""). */
  unreadable?: boolean;
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
          `SELECT name, value, CAST(lastAccessed AS REAL) AS lastAccessed FROM moz_cookies
           WHERE host IN (${hp}) AND name IN (${ph})`,
        )
        .all(...hosts, ...names) as any[]
    ).map((r) => ({ name: String(r.name), value: String(r.value), lastAccess: Number(r.lastAccessed) }));
  });
}

/**
 * kwallet-query arguments that read a Chromium browser's "Safe Storage" secret
 * on KDE. The secret lives in the wallet folder "<Product> Keys" under the
 * entry "<Product> Safe Storage" (e.g. folder "Chromium Keys", entry "Chromium
 * Safe Storage"). The wallet defaults to "kdewallet"; BLATTBOT_KWALLET overrides
 * it. Pure — exported for unit tests.
 */
export function kwalletArgs(service: string, wallet = process.env.BLATTBOT_KWALLET || "kdewallet"): string[] {
  const product = service.replace(/ Safe Storage$/, "");
  return ["-r", `${product} Safe Storage`, "-f", `${product} Keys`, wallet];
}

/** kwallet-query prints a message (exit 0) instead of a value when it misses. */
function looksLikeKwalletMiss(out: string): boolean {
  return out === "" || /not (found|exist)|does not exist|failed to|no such/i.test(out);
}

/**
 * The Chromium Safe Storage secret from KWallet (KDE's default password store).
 * On a stock KDE install Chromium does NOT register this secret with the
 * freedesktop Secret Service, so secret-tool cannot see it — kwallet-query is
 * the only way to reach it. Best-effort and time-bounded so a locked or absent
 * wallet never hangs the import. Exported for unit tests.
 */
export function kwalletSecret(
  service: string,
  run: (bin: string, args: string[]) => string = defaultKwalletRun,
): string {
  for (const bin of ["kwallet-query", "kwallet-query5"]) {
    try {
      const out = run(bin, kwalletArgs(service)).trim();
      if (!looksLikeKwalletMiss(out)) return out;
    } catch {
      /* not installed / wallet closed / timed out */
    }
  }
  return "";
}

function defaultKwalletRun(bin: string, args: string[]): string {
  return execFileSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

/** Real keyring secrets, memoized per service: they never change, and a
 *  locked-wallet probe costs seconds. The "peanuts" fallback is never cached
 *  so an unlocked wallet is picked up on the next scan. */
const secretCache = new Map<string, string>();

/** Fetch the OS storage secret for a Chromium browser (Linux/macOS keyring). */
function chromiumStorageSecret(service?: string): string {
  const cached = service && secretCache.get(service);
  if (cached) return cached;
  const secret = lookupStorageSecret(service);
  if (service && secret !== "peanuts") secretCache.set(service, secret);
  return secret;
}

function lookupStorageSecret(service?: string): string {
  const p = platform();
  if (p === "linux" && service) {
    // 1) freedesktop Secret Service — GNOME libsecret, and KDE setups that
    //    bridge kwallet to it. Reached by both GNOME Keyring and gnome-keyring.
    try {
      const out = execFileSync("secret-tool", ["lookup", "application", service.replace(/ Safe Storage$/, "").toLowerCase()], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
      if (out) return out;
    } catch {
      /* keyring locked or absent */
    }
    // 2) KWallet — the KDE default store, where Chromium keeps its secret and
    //    which secret-tool usually cannot see. Without this, every cookie in a
    //    KDE Chromium/Chrome/Brave profile fails to decrypt and browser
    //    sign-in silently finds nothing (the "paste it manually" symptom).
    const kw = kwalletSecret(service);
    if (kw) return kw;
    // 3) Common Linux fallback secret when no keyring is available ("basic" storage).
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

/** Unwrapped Windows keys per Local State file (one PowerShell round-trip each). */
const gcmKeyCache = new Map<string, Buffer>();

/**
 * Windows: decrypt the AES-256-GCM key stored (DPAPI-wrapped) in Local State.
 * Runs on Windows itself (`powershell`) and from WSL (`powershell.exe` through
 * interop, as the same Windows user — which is what DPAPI requires).
 */
function windowsGcmKey(localStatePath?: string): Buffer | null {
  if (!localStatePath || !existsSync(localStatePath)) return null;
  const cached = gcmKeyCache.get(localStatePath);
  if (cached) return cached;
  const powershell = platform() === "win32" ? "powershell" : windowsExe(join("WindowsPowerShell", "v1.0", "powershell.exe"));
  if (!powershell) return null;
  try {
    const state = JSON.parse(readFileSync(localStatePath, "utf8"));
    const b64 = state?.os_crypt?.encrypted_key;
    if (!b64) return null;
    let wrapped = Buffer.from(b64, "base64");
    if (wrapped.subarray(0, 5).toString("ascii") === "DPAPI") wrapped = wrapped.subarray(5);
    // Unwrap via PowerShell's ProtectedData (no native module needed).
    // System.Security is not preloaded in Windows PowerShell 5.1.
    const b64wrapped = wrapped.toString("base64");
    const ps =
      `Add-Type -AssemblyName System.Security; ` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(` +
      `[Convert]::FromBase64String('${b64wrapped}'),$null,'CurrentUser'))`;
    const out = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    }).trim();
    if (!out) return null;
    const key = Buffer.from(out, "base64");
    gcmKeyCache.set(localStatePath, key);
    return key;
  } catch {
    return null;
  }
}

/** The decryption keys for one Chromium profile, per the OS that wrote it. */
function chromiumKeys(profile: BrowserProfile): { cbcKey?: Buffer; gcmKey?: Buffer } {
  switch (profile.crypt) {
    case "windows":
      return { gcmKey: windowsGcmKey(profile.localState) ?? undefined };
    case "darwin":
      return { cbcKey: deriveCbcKey(chromiumStorageSecret(profile.safeStorageService), 1003) };
    default: {
      const secret = chromiumStorageSecret(profile.safeStorageService);
      return { cbcKey: secret === "peanuts" ? LINUX_FALLBACK_KEY : deriveCbcKey(secret, 1) };
    }
  }
}

/**
 * Read + decrypt named cookies for a host from a Chromium Cookies db. A cookie
 * whose value cannot be decrypted (missing key, app-bound "v20" scheme) is
 * returned with an empty value and `unreadable`, so callers can say so.
 */
export function readChromium(profile: BrowserProfile, host: string, names: string[]): CookieRow[] {
  // Keys are fetched lazily: the keyring/DPAPI round-trip only happens when a
  // matching encrypted row exists.
  let keys: { cbcKey?: Buffer; gcmKey?: Buffer } | undefined;
  const getKeys = () => (keys ??= chromiumKeys(profile));

  return openCopied(profile.cookieDb, (db) => {
    const hosts = cookieHostKeys(host);
    const hp = hosts.map(() => "?").join(",");
    const ph = names.map(() => "?").join(",");
    const rows = db
      .prepare(
        // last_access_utc is microseconds since 1601 (~1.3e16) — larger than
        // Number.MAX_SAFE_INTEGER, so node:sqlite THROWS while materializing an
        // INTEGER column that big. CAST it to REAL (a double, ample for the
        // recency ordering) so reading a real profile's cookies never throws.
        `SELECT name, encrypted_value, value, CAST(last_access_utc AS REAL) AS last_access_utc
         FROM cookies WHERE host_key IN (${hp}) AND name IN (${ph})`,
      )
      .all(...hosts, ...names) as any[];
    const out: CookieRow[] = [];
    for (const r of rows) {
      let value = "";
      const enc = r.encrypted_value as Buffer | Uint8Array | null;
      if (enc && enc.length > 0) {
        try {
          value = decryptChromiumCookie(Buffer.from(enc), { ...getKeys(), stripDomainHash: true }) ?? "";
        } catch {
          value = "";
        }
      } else if (typeof r.value === "string") {
        value = r.value;
      }
      const row: CookieRow = { name: String(r.name), value, lastAccess: Number(r.last_access_utc) };
      if (!value) row.unreadable = true;
      out.push(row);
    }
    return out;
  });
}
