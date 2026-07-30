import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-auth-test-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  return await import("../src/auth.js");
}

describe("auth token", () => {
  it("generates once, persists 0600, and stays stable", async () => {
    const a = await load();
    const t1 = a.getAuthToken();
    expect(t1).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(dir, "auth-token")).mode & 0o777).toBe(0o600);
    vi.resetModules();
    const b = await load();
    expect(b.getAuthToken()).toBe(t1);
  });
});

describe("hostAllowed", () => {
  it("accepts loopback hosts with the right port only", async () => {
    const { hostAllowed } = await load();
    expect(hostAllowed("127.0.0.1:4560", 4560)).toBe(true);
    expect(hostAllowed("localhost:4560", 4560)).toBe(true);
    expect(hostAllowed("LOCALHOST:4560", 4560)).toBe(true);
    expect(hostAllowed("[::1]:4560", 4560)).toBe(true);
    // DNS rebinding: attacker's domain resolving to 127.0.0.1 still sends its own Host.
    expect(hostAllowed("evil.example:4560", 4560)).toBe(false);
    expect(hostAllowed("127.0.0.1:4561", 4560)).toBe(false);
    expect(hostAllowed(undefined, 4560)).toBe(false);
  });
});

describe("requestAuthorized", () => {
  it("accepts the Bearer header or the auth cookie, rejects everything else", async () => {
    const a = await load();
    const t = a.getAuthToken();
    expect(a.requestAuthorized({ authorization: `Bearer ${t}` })).toBe(true);
    expect(a.requestAuthorized({ cookie: `${a.AUTH_COOKIE}=${t}` })).toBe(true);
    expect(a.requestAuthorized({ cookie: `other=x; ${a.AUTH_COOKIE}=${t}; more=y` })).toBe(true);
    expect(a.requestAuthorized({})).toBe(false);
    expect(a.requestAuthorized({ authorization: "Bearer wrong" })).toBe(false);
    expect(a.requestAuthorized({ cookie: `${a.AUTH_COOKIE}=wrong` })).toBe(false);
    expect(a.requestAuthorized({ cookie: `x${a.AUTH_COOKIE}=${t}` })).toBe(false);
  });
});
