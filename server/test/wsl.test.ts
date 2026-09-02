import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWsl, windowsDrives, windowsExe, windowsUserHomes } from "../src/overleaf/wsl.js";
import { captureViaWindowsBrowser, type BrowserScan } from "../src/overleaf/cookiegrab.js";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "blattbot-wsl-"));
  process.env.BLATTBOT_WSL_MNT = join(sandbox, "mnt");
});

afterEach(() => {
  delete process.env.BLATTBOT_WSL;
  delete process.env.BLATTBOT_WSL_MNT;
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("WSL detection and Windows-side discovery", () => {
  it("honours the BLATTBOT_WSL override in both directions", () => {
    process.env.BLATTBOT_WSL = "1";
    expect(isWsl()).toBe(true);
    process.env.BLATTBOT_WSL = "0";
    expect(isWsl()).toBe(false);
  });

  it("lists mounted drives system-drive first and finds System32 executables", () => {
    mkdirSync(join(sandbox, "mnt", "d"), { recursive: true });
    mkdirSync(join(sandbox, "mnt", "c", "Windows", "System32"), { recursive: true });
    mkdirSync(join(sandbox, "mnt", "wslg"), { recursive: true });
    writeFileSync(join(sandbox, "mnt", "c", "Windows", "System32", "cmd.exe"), "");
    expect(windowsDrives()).toEqual([join(sandbox, "mnt", "c"), join(sandbox, "mnt", "d")]);
    expect(windowsExe("cmd.exe")).toBe(join(sandbox, "mnt", "c", "Windows", "System32", "cmd.exe"));
    expect(windowsExe("nope.exe")).toBeNull();
  });

  it("returns only real user homes (those with AppData), skipping Public/Default", () => {
    for (const u of ["luke", "Public", "Default", "All Users", "no-appdata"]) {
      mkdirSync(join(sandbox, "mnt", "c", "Users", u), { recursive: true });
    }
    for (const u of ["luke", "Public", "Default"]) {
      mkdirSync(join(sandbox, "mnt", "c", "Users", u, "AppData"), { recursive: true });
    }
    expect(windowsUserHomes()).toEqual([join(sandbox, "mnt", "c", "Users", "luke")]);
  });

  it("copes with no /mnt at all", () => {
    expect(windowsDrives()).toEqual([]);
    expect(windowsUserHomes()).toEqual([]);
    expect(windowsExe("cmd.exe")).toBeNull();
  });
});

describe("captureViaWindowsBrowser (WSL login fallback)", () => {
  const BASE = "https://overleaf.uni-paderborn.de";
  const none: BrowserScan = { found: [], unreadable: [] };

  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("opens the login page in Windows and returns the first cookie that authenticates", async () => {
    const opened: string[] = [];
    const scans: BrowserScan[] = [
      none,
      { found: [{ cookie: "overleaf.sid=anon", source: "Firefox (Windows)" }], unreadable: [] },
      { found: [{ cookie: "overleaf.sid=logged-in", source: "Firefox (Windows)" }], unreadable: [] },
    ];
    const checked: string[] = [];
    const found = await captureViaWindowsBrowser(
      BASE,
      { pollMs: 10 },
      {
        ...clock(),
        open: (url) => (opened.push(url), true),
        scan: () => scans.shift() ?? scans[0] ?? none,
        works: async (_b, cookie) => (checked.push(cookie), cookie.includes("logged-in")),
      },
    );
    expect(opened).toEqual([`${BASE}/login`]);
    expect(found).toEqual({ cookie: "overleaf.sid=logged-in", source: "Firefox (Windows)" });
    // The anonymous cookie is checked once, never again.
    expect(checked).toEqual(["overleaf.sid=anon", "overleaf.sid=logged-in"]);
  });

  it("fails clearly when no Windows browser can be launched", async () => {
    await expect(
      captureViaWindowsBrowser(BASE, {}, { ...clock(), open: () => false, scan: () => none, works: async () => true }),
    ).rejects.toThrow(/could not open a Windows browser/);
  });

  it("names the unreadable browsers when the login never becomes visible", async () => {
    const c = clock();
    await expect(
      captureViaWindowsBrowser(
        BASE,
        { timeoutMs: 50, pollMs: 10 },
        { ...c, open: () => true, scan: () => ({ found: [], unreadable: ["Chrome (Windows)"] }), works: async () => true },
      ),
    ).rejects.toThrow(/Chrome \(Windows\) could not be read/);
  });
});
