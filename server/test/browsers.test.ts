import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CBC_IV, LINUX_FALLBACK_KEY } from "../src/overleaf/chromium-crypto.js";

// browsers.ts reads os.platform() and $HOME at call time; pin platform to linux
// and point HOME at a synthetic tree so the whole discovery path is exercised.
vi.mock("node:os", async (orig) => {
  const actual = (await orig()) as typeof import("node:os");
  return { ...actual, platform: () => "linux" };
});

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "blattbot-browsers-"));
  process.env.BLATTBOT_HOME = sandbox;
  process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
});

afterEach(() => {
  delete process.env.BLATTBOT_HOME;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function encCbc(value: string, key: Buffer): Buffer {
  const body = Buffer.concat([createHash("sha256").update("overleaf.uni-paderborn.de").digest(), Buffer.from(value)]);
  const cipher = createCipheriv("aes-128-cbc", key, CBC_IV);
  return Buffer.concat([Buffer.from("v10"), cipher.update(body), cipher.final()]);
}

function writeFirefoxDb(profileDir: string, host: string, name: string, value: string) {
  mkdirSync(profileDir, { recursive: true });
  const db = new DatabaseSync(join(profileDir, "cookies.sqlite"));
  db.exec(
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, lastAccessed INTEGER)",
  );
  db.prepare("INSERT INTO moz_cookies (name, value, host, lastAccessed) VALUES (?,?,?,?)").run(name, value, host, 100);
  db.close();
}

function writeChromiumDb(dbPath: string, host: string, name: string, encrypted: Buffer, lastAccess = 200) {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, last_access_utc INTEGER)",
  );
  db.prepare(
    "INSERT INTO cookies (host_key, name, value, encrypted_value, last_access_utc) VALUES (?,?,?,?,?)",
  ).run(host, name, "", encrypted, lastAccess);
  db.close();
}

describe("discoverProfiles + readers (Linux tree)", () => {
  const HOST = "overleaf.uni-paderborn.de";

  it("finds a Firefox session cookie (plaintext)", async () => {
    writeFirefoxDb(
      join(sandbox, ".mozilla", "firefox", "abc.default"),
      HOST,
      "overleaf_session2",
      "s%3Afirefox-value",
    );
    const { importFromBrowsers } = await import("../src/overleaf/cookiegrab.js");
    const found = importFromBrowsers(`https://${HOST}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cookie: "overleaf_session2=s%3Afirefox-value", source: "Firefox" });
  });

  it("finds and decrypts a Chromium session cookie under Default/Network/Cookies", async () => {
    writeChromiumDb(
      join(sandbox, ".config", "google-chrome", "Default", "Network", "Cookies"),
      HOST,
      "overleaf_session2",
      encCbc("s%3Achrome-value", LINUX_FALLBACK_KEY),
    );
    const { importFromBrowsers } = await import("../src/overleaf/cookiegrab.js");
    const found = importFromBrowsers(`https://${HOST}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cookie: "overleaf_session2=s%3Achrome-value", source: "Chrome" });
  });

  it("returns newest-first candidates across multiple browsers and dedupes", async () => {
    writeFirefoxDb(join(sandbox, ".mozilla", "firefox", "p.default"), HOST, "overleaf_session2", "old-firefox");
    writeChromiumDb(
      join(sandbox, ".config", "BraveSoftware", "Brave-Browser", "Default", "Cookies"),
      HOST,
      "overleaf_session2",
      encCbc("newer-brave", LINUX_FALLBACK_KEY),
      999_999,
    );
    const { importFromBrowsers } = await import("../src/overleaf/cookiegrab.js");
    const found = importFromBrowsers(`https://${HOST}`);
    expect(found.map((f) => f.source)).toEqual(["Brave", "Firefox"]); // Brave last-access newer
  });

  it("returns nothing for a host with no stored session", async () => {
    writeFirefoxDb(join(sandbox, ".mozilla", "firefox", "p.default"), "other.example.com", "overleaf_session2", "x");
    const { importFromBrowsers } = await import("../src/overleaf/cookiegrab.js");
    expect(importFromBrowsers(`https://${HOST}`)).toEqual([]);
  });

  // Regression: a real Chromium last_access_utc is microseconds since 1601
  // (~1.3e16), which overflows Number.MAX_SAFE_INTEGER — node:sqlite threw while
  // reading the column, importFromBrowsers swallowed the throw, and Chromium
  // silently yielded nothing. The fixture used to use tiny values, hiding it.
  it("reads a Chromium cookie whose last_access_utc overflows a JS safe integer", async () => {
    const realUtc = 13_431_775_128_232_436; // ~2026, in 1601-based microseconds
    expect(realUtc).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // Uses the google-chrome path (like the decrypt test above): "Chrome" has
    // no kwallet entry on a dev box, so this stays a pure overflow check and
    // does not depend on the local keyring.
    writeChromiumDb(
      join(sandbox, ".config", "google-chrome", "Default", "Cookies"),
      HOST,
      "overleaf.sid",
      encCbc("s%3Achrome-value", LINUX_FALLBACK_KEY),
      realUtc,
    );
    const { importFromBrowsers } = await import("../src/overleaf/cookiegrab.js");
    const found = importFromBrowsers(`https://${HOST}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cookie: "overleaf.sid=s%3Achrome-value", source: "Chrome" });
  });
});

describe("kwallet secret retrieval (KDE)", () => {
  it("builds the folder/entry/wallet args from the safe-storage service name", async () => {
    const { kwalletArgs } = await import("../src/overleaf/browsers.js");
    expect(kwalletArgs("Chromium Safe Storage")).toEqual([
      "-r",
      "Chromium Safe Storage",
      "-f",
      "Chromium Keys",
      "kdewallet",
    ]);
    expect(kwalletArgs("Chrome Safe Storage")).toEqual(["-r", "Chrome Safe Storage", "-f", "Chrome Keys", "kdewallet"]);
    expect(kwalletArgs("Brave Safe Storage", "mywallet")).toEqual([
      "-r",
      "Brave Safe Storage",
      "-f",
      "Brave Keys",
      "mywallet",
    ]);
  });

  it("returns the wallet value, and '' on a miss message or when the tool is absent", async () => {
    const { kwalletSecret } = await import("../src/overleaf/browsers.js");
    expect(kwalletSecret("Chromium Safe Storage", () => "the-secret\n")).toBe("the-secret");
    // kwallet-query prints a message (exit 0) when the entry is missing.
    expect(kwalletSecret("Chromium Safe Storage", () => "The folder Chromium Keys does not exist!")).toBe("");
    expect(kwalletSecret("Chromium Safe Storage", () => "")).toBe("");
    expect(
      kwalletSecret("Chromium Safe Storage", () => {
        throw new Error("kwallet-query: not found");
      }),
    ).toBe("");
  });

  it("falls back through both kwallet-query binaries", async () => {
    const { kwalletSecret } = await import("../src/overleaf/browsers.js");
    const tried: string[] = [];
    const secret = kwalletSecret("Chromium Safe Storage", (bin) => {
      tried.push(bin);
      if (bin === "kwallet-query") throw new Error("no kwallet-query on KDE5");
      return "secret-from-query5";
    });
    expect(tried).toEqual(["kwallet-query", "kwallet-query5"]);
    expect(secret).toBe("secret-from-query5");
  });
});
