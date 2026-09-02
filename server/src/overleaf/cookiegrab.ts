/**
 * Automatic session-cookie acquisition:
 *  1. Import from any installed browser (Firefox/Chrome/Edge/Brave/Chromium/…)
 *     across Linux, macOS, and Windows — the user is usually already logged in.
 *     Under WSL the Windows browsers' stores are read from /mnt/<drive>.
 *  2. Assisted login: open a real browser window on the instance's login page
 *     and capture the session cookie the moment it appears (works with SSO).
 *     Under WSL without a Linux Chromium, the Windows default browser opens
 *     and the Windows cookie stores are watched instead.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { discoverProfiles, readChromium, readFirefox, type CookieRow } from "./browsers.js";
import { OverleafClient } from "./olclient.js";
import { isWsl, openInWindowsBrowser } from "./wsl.js";

/** Session cookie names across Overleaf versions (newest first = preferred). */
export const SESSION_COOKIE_NAMES = ["overleaf_session2", "overleaf.sid", "sharelatex.sid"];

/**
 * Companion cookies the session must travel with. www.overleaf.com sits behind
 * a load balancer with session affinity — presenting the session cookie
 * WITHOUT its GCLB cookie can land on a backend that treats you as logged out.
 */
export const COMPANION_COOKIE_NAMES = ["GCLB"];

export interface FoundCookie {
  cookie: string; // name=value
  source: string;
}

export interface BrowserScan {
  /** Usable session cookies, newest first. */
  found: FoundCookie[];
  /**
   * Browsers that hold a session cookie for the host which could not be read:
   * the store is locked by the running browser, or the value is encrypted with
   * a key we cannot get (Chrome/Edge on Windows: app-bound encryption).
   */
  unreadable: string[];
}

function rank(rows: CookieRow[]): CookieRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) =>
      SESSION_COOKIE_NAMES.indexOf(a.name) - SESSION_COOKIE_NAMES.indexOf(b.name) ||
      b.lastAccess - a.lastAccess,
  )[0];
}

/**
 * Scan every installed browser for a session cookie of the given instance.
 * Candidates come newest-first; the caller validates them against the
 * instance and uses the first that works.
 */
export function scanBrowsers(baseUrl: string): BrowserScan {
  const host = new URL(baseUrl).hostname;
  const candidates: { found: FoundCookie; lastAccess: number }[] = [];
  const unreadable = new Set<string>();
  const allNames = [...SESSION_COOKIE_NAMES, ...COMPANION_COOKIE_NAMES];
  for (const profile of discoverProfiles()) {
    try {
      const rows =
        profile.family === "firefox"
          ? readFirefox(profile.cookieDb, host, allNames)
          : readChromium(profile, host, allNames);
      const sessions = rows.filter((r) => SESSION_COOKIE_NAMES.includes(r.name));
      const best = rank(sessions.filter((r) => r.value));
      if (best) {
        // The session cookie travels with its companions from the same profile.
        const companions = rows
          .filter((r) => r.value && COMPANION_COOKIE_NAMES.includes(r.name))
          .map((r) => `${r.name}=${r.value}`);
        candidates.push({
          found: {
            cookie: [`${best.name}=${best.value}`, ...companions].join("; "),
            source: profile.browser,
          },
          lastAccess: best.lastAccess,
        });
      } else if (sessions.some((r) => r.unreadable)) {
        unreadable.add(profile.browser);
      }
    } catch {
      // Locked (the browser holds the store open) or otherwise unreadable
      // profile. Chrome on Windows locks its cookie db while running.
      unreadable.add(profile.browser);
    }
  }
  candidates.sort((a, b) => b.lastAccess - a.lastAccess);
  // De-dupe identical cookies from multiple profiles.
  const seen = new Set<string>();
  const found = candidates
    .filter((c) => (seen.has(c.found.cookie) ? false : (seen.add(c.found.cookie), true)))
    .map((c) => c.found);
  return { found, unreadable: [...unreadable] };
}

/** The usable session cookies from every installed browser, newest first. */
export function importFromBrowsers(baseUrl: string): FoundCookie[] {
  return scanBrowsers(baseUrl).found;
}

/** Why a scan turned up nothing usable, in the user's terms. */
export function noSessionMessage(host: string, scan: BrowserScan): string {
  const wsl = isWsl();
  const parts = [
    `No session cookie for ${host} found in ${wsl ? "your Windows browsers (scanned from WSL)" : "any installed browser"}.`,
  ];
  if (scan.unreadable.length > 0) {
    parts.push(
      `${scan.unreadable.join(", ")} ${scan.unreadable.length === 1 ? "has" : "have"} a session for ${host} that could not be read or decrypted` +
        (wsl
          ? " — Chrome and Edge on Windows lock their cookies to the browser itself (app-bound encryption); Firefox works."
          : " — the store may be locked by the running browser, or its keyring secret is unavailable."),
    );
  }
  parts.push(
    wsl
      ? "Log in to Overleaf once in Firefox on Windows, use the browser login, or paste the cookie."
      : "Log in to Overleaf once, or use the browser login.",
  );
  return parts.join(" ");
}

function findChromiumExecutable(): string | null {
  // A real installed browser first: Google's OAuth refuses "insecure" browsers,
  // and branded Chrome/Chromium builds pass where the Playwright build won't.
  for (const p of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ]) {
    if (existsSync(p)) return p;
  }
  const pwCache = join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(pwCache)
      .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-linux64", "chrome-linux", "chrome-win", "chrome-mac"]) {
        for (const bin of ["chrome", "chrome.exe", "Chromium.app/Contents/MacOS/Chromium"]) {
          const p = join(pwCache, d, sub, bin);
          if (existsSync(p)) return p;
        }
      }
    }
  } catch {
    /* no playwright cache */
  }
  return null;
}

let captureActive = false;

export interface CaptureOptions {
  headless?: boolean;
  timeoutMs?: number;
  /** WSL fallback: how often to re-read the Windows cookie stores. */
  pollMs?: number;
}

async function authenticates(baseUrl: string, cookie: string): Promise<boolean> {
  return new OverleafClient(baseUrl, cookie)
    .csrf()
    .then(() => true)
    .catch(() => false);
}

/**
 * Open a browser on the instance's login page and wait for a session cookie to
 * appear (the user completes the login, SSO included). Environment-independent
 * fallback — works wherever a Chromium binary is available. Under WSL with no
 * Linux Chromium (or no display), the Windows default browser is used instead.
 */
export async function captureViaBrowser(baseUrl: string, opts: CaptureOptions = {}): Promise<FoundCookie> {
  if (captureActive) throw new Error("a login capture is already in progress");
  captureActive = true;
  try {
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      if (isWsl()) return await captureViaWindowsBrowser(baseUrl, opts);
      throw new Error("no Chromium found for the login window — install a browser or paste the cookie manually");
    }
    try {
      return await captureViaChromium(baseUrl, executablePath, opts);
    } catch (err) {
      // A WSL distro without WSLg cannot show a window; the Windows side can.
      if (isWsl() && err instanceof Error && /launch|display|x server|xvfb|target closed/i.test(err.message)) {
        return await captureViaWindowsBrowser(baseUrl, opts);
      }
      throw err;
    }
  } finally {
    captureActive = false;
  }
}

async function captureViaChromium(
  baseUrl: string,
  executablePath: string,
  opts: CaptureOptions,
): Promise<FoundCookie> {
  const { chromium } = await import("playwright-core");
  // A persistent profile + stripped automation flags: Google's OAuth refuses
  // browsers that look automated ("This browser or app may not be secure"),
  // and a profile that persists means SSO stays signed in for next time.
  const context = await chromium.launchPersistentContext(join(DATA_DIR, "login-profile"), {
    executablePath,
    headless: opts.headless ?? false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const host = new URL(baseUrl).hostname;
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    let lastChecked = "";
    while (Date.now() < deadline) {
      const cookies = await context.cookies(baseUrl).catch(() => []);
      // Parent-domain cookies count too: a www.overleaf.com session lives
      // under ".overleaf.com".
      const forHost = cookies.filter((c) => {
        const d = c.domain.replace(/^\./, "");
        return host === d || host.endsWith(`.${d}`);
      });
      const hit = forHost
        .filter((c) => SESSION_COOKIE_NAMES.includes(c.name))
        .sort((a, b) => SESSION_COOKIE_NAMES.indexOf(a.name) - SESSION_COOKIE_NAMES.indexOf(b.name))[0];
      if (hit) {
        const companions = forHost
          .filter((c) => COMPANION_COOKIE_NAMES.includes(c.name))
          .map((c) => `${c.name}=${c.value}`);
        const candidate = [`${hit.name}=${hit.value}`, ...companions].join("; ");
        // overleaf.com hands out a session cookie even ANONYMOUSLY, and SSO
        // flows (Google) navigate away from /login long before they finish —
        // so never trust presence or URL: close only once the cookie actually
        // AUTHENTICATES against the instance. Only re-check when it changed.
        if (candidate !== lastChecked) {
          lastChecked = candidate;
          if (await authenticates(baseUrl, candidate)) return { cookie: candidate, source: "browser login" };
        }
      }
      if (page.isClosed()) throw new Error("login window was closed before a session appeared");
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error(
      "timed out waiting for login (3 minutes) — if Google refused the sign-in, log in to Overleaf in your normal browser instead and use “Sign in from browser session”",
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/** Injectable pieces of the WSL login flow, for unit tests. */
export interface WindowsCaptureDeps {
  open: (url: string) => boolean;
  scan: (baseUrl: string) => BrowserScan;
  works: (baseUrl: string, cookie: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultWindowsDeps: WindowsCaptureDeps = {
  open: openInWindowsBrowser,
  scan: scanBrowsers,
  works: authenticates,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * WSL: open the login page in the Windows default browser and watch the
 * Windows browsers' cookie stores until a session that authenticates shows up.
 * Firefox writes its store promptly and in plaintext; Chrome and Edge lock and
 * app-bind theirs, so a login there is invisible to us — say so on timeout.
 */
export async function captureViaWindowsBrowser(
  baseUrl: string,
  opts: CaptureOptions = {},
  deps: WindowsCaptureDeps = defaultWindowsDeps,
): Promise<FoundCookie> {
  if (!deps.open(`${baseUrl}/login`)) {
    throw new Error(
      "could not open a Windows browser from WSL — log in to Overleaf in your Windows browser yourself, then use “Sign in from browser session”, or paste the cookie",
    );
  }
  const deadline = deps.now() + (opts.timeoutMs ?? 180_000);
  const rejected = new Set<string>();
  let unreadable: string[] = [];
  while (deps.now() < deadline) {
    const scan = deps.scan(baseUrl);
    unreadable = scan.unreadable;
    for (const c of scan.found) {
      // Overleaf regenerates the session on login, so a cookie that failed
      // once stays failed; only fresh values are worth a round-trip.
      if (rejected.has(c.cookie)) continue;
      if (await deps.works(baseUrl, c.cookie)) return c;
      rejected.add(c.cookie);
    }
    await deps.sleep(opts.pollMs ?? 2_000);
  }
  const blocked =
    unreadable.length > 0
      ? ` ${unreadable.join(", ")} could not be read — Chrome and Edge on Windows lock their cookies to the browser itself.`
      : "";
  throw new Error(
    `timed out waiting for login (3 minutes). BlattBot watched your Windows browsers' cookie stores from WSL.${blocked} Log in with Firefox on Windows, or paste the cookie.`,
  );
}
