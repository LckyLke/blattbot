import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-accounts-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  const config = await import("../src/config.js");
  const accounts = await import("../src/accounts.js");
  return { config, accounts };
}

describe("accounts store", () => {
  it("creates and updates accounts per instance", async () => {
    const { accounts } = await load();
    const a = accounts.upsertAccount({
      baseUrl: "https://overleaf.uni-paderborn.de",
      cookie: "overleaf.sid=one",
      email: "luke@uni.example",
    });
    expect(a.status).toBe("connected");
    expect(a.id).toContain("overleaf-uni-paderborn-de");

    // Same instance + same email → same account, refreshed cookie.
    const again = accounts.upsertAccount({
      baseUrl: "https://overleaf.uni-paderborn.de/",
      cookie: "overleaf.sid=two",
      email: "luke@uni.example",
    });
    expect(again.id).toBe(a.id);
    expect(accounts.getAccount(a.id)?.cookie).toBe("overleaf.sid=two");
    expect(accounts.listAccounts()).toHaveLength(1);
  });

  it("keeps two different logins on the same instance separate", async () => {
    const { accounts } = await load();
    const a = accounts.upsertAccount({
      baseUrl: "https://www.overleaf.com",
      cookie: "overleaf_session2=a",
      email: "personal@example.org",
    });
    const b = accounts.upsertAccount({
      baseUrl: "https://www.overleaf.com",
      cookie: "overleaf_session2=b",
      email: "work@example.org",
    });
    expect(b.id).not.toBe(a.id);
    expect(accounts.listAccounts()).toHaveLength(2);
  });

  it("supports different instances side by side", async () => {
    const { accounts } = await load();
    accounts.upsertAccount({ baseUrl: "https://www.overleaf.com", cookie: "x" });
    accounts.upsertAccount({ baseUrl: "https://overleaf.uni-paderborn.de", cookie: "y" });
    const hosts = accounts.listAccounts().map((a) => accounts.publicAccount(a).host);
    expect(hosts.sort()).toEqual(["overleaf.uni-paderborn.de", "www.overleaf.com"]);
  });

  it("never exposes the cookie in the public view", async () => {
    const { accounts } = await load();
    const a = accounts.upsertAccount({ baseUrl: "https://www.overleaf.com", cookie: "secret" });
    expect(JSON.stringify(accounts.publicAccount(a))).not.toContain("secret");
  });

  it("migrates legacy per-project cookies into accounts", async () => {
    const { config, accounts } = await load();
    const p = config.addProject({
      name: "Thesis",
      gitUrl: "https://overleaf.uni-paderborn.de/project/6a38f942205a91b533c318be",
      kind: "overleaf",
      overleafBaseUrl: "https://overleaf.uni-paderborn.de",
      overleafProjectId: "6a38f942205a91b533c318be",
      cookie: "overleaf.sid=legacy",
    });

    accounts.migrateProjectCookies();

    const migrated = config.getProject(p.id)!;
    expect(migrated.accountId).toBeTruthy();
    expect(migrated.cookie).toBeUndefined();
    // The registry file must not keep the raw cookie on the project.
    const raw = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    expect(raw[0].cookie).toBeUndefined();
    expect(accounts.cookieForProject(migrated)).toBe("overleaf.sid=legacy");
    // Idempotent.
    accounts.migrateProjectCookies();
    expect(accounts.listAccounts()).toHaveLength(1);
  });
});

describe("settings store", () => {
  async function loadSettingsModule() {
    return await import("../src/settings.js");
  }

  it("returns defaults when no file exists", async () => {
    const s = await loadSettingsModule();
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
  });

  it("merges partial saves and keeps unknown keys out", async () => {
    const s = await loadSettingsModule();
    s.saveSettings({ model: "opus" });
    s.saveSettings({ engine: "latexmk", bogus: "nope" } as any);
    const loaded = s.loadSettings();
    expect(loaded.model).toBe("opus");
    expect(loaded.engine).toBe("latexmk");
    expect((loaded as any).bogus).toBeUndefined();
  });

  it("redacts the API key in the public view", async () => {
    const s = await loadSettingsModule();
    s.saveSettings({ apiKey: "sk-ant-secret" });
    const pub = s.publicSettings();
    expect(JSON.stringify(pub)).not.toContain("sk-ant-secret");
    expect(pub.hasApiKey).toBe(true);
    s.saveSettings({ apiKey: "" });
    expect(s.publicSettings().hasApiKey).toBe(false);
  });
});
