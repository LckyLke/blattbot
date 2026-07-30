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
  rmSync(sandbox, { recursive: true, force: true });
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
});
