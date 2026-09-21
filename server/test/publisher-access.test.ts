import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import type { Cookie } from "playwright-core";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
let root: string;
const cookie = (name = "publisher-session", domain = ".publisher.example", extra: Partial<Cookie> = {}): Cookie => ({ name, value: "private-cookie-value", domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax", ...extra });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blattbot-publisher-access-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
});
afterEach(async () => {
  const { cancelPublisherLogin } = await import("../src/publisher-access.js");
  await cancelPublisherLogin();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function fakeBrowser(initialUrl = "https://publisher.example/") {
  let currentUrl = initialUrl;
  const page = { url: () => currentUrl, goto: vi.fn(async () => {}) };
  const context = { pages: () => [page], cookies: vi.fn(async () => [cookie(), cookie("university-secret", ".university.example")]), addCookies: vi.fn(), newPage: vi.fn(async () => page) };
  const browser = Object.assign(new EventEmitter(), { newContext: vi.fn(async () => context), isConnected: () => true, close: vi.fn(async () => { browser.emit("disconnected"); }) });
  return { browser: browser as any, context, navigate: (url: string) => { currentUrl = url; } };
}

describe("publisher session boundary", () => {
  it("saves only publisher cookies, hides secrets publicly, and protects them even in attached context", async () => {
    const access = await import("../src/publisher-access.js");
    const saved = access.savePublisherSession("https://publisher.example", "Any University", [cookie(), cookie("university-secret", ".university.example"), cookie("other-secret", ".unrelated.example")]);
    expect(saved).toMatchObject({ institution: "Any University", status: "saved" });
    expect(JSON.stringify(access.listPublisherAccess())).not.toContain("private-cookie-value");
    const path = join(root, "research-secrets", "publisher-access.json");
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain("publisher-session");
    expect(stored).not.toContain("university-secret");
    expect(stored).not.toContain("other-secret");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const project = join(root, "project"); mkdirSync(project);
    const { resolveReadPath } = await import("../src/backends/paths.js");
    expect(() => resolveReadPath(project, [root], path)).toThrow("credentials");
  });
  it("restricts cookies to exact origin, domain, path and unexpired lifetime", async () => {
    const access = await import("../src/publisher-access.js");
    access.savePublisherSession("https://publisher.example", "", [cookie(), cookie("article", ".publisher.example", { path: "/article" }), cookie("expired", ".publisher.example", { expires: 1 })]);
    const header = (url: string) => access.publisherCookieForUrl(new URL(url));
    expect(header("https://publisher.example/article/1")).toBe("article=private-cookie-value; publisher-session=private-cookie-value");
    expect(header("https://publisher.example/articles")).toBe("publisher-session=private-cookie-value");
    for (const url of ["http://publisher.example/article", "https://publisher.example:8443/article", "https://sub.publisher.example/article", "https://university.example/", "https://publisher.example.evil.test/", "https://user:secret@publisher.example/"])
      expect(header(url)).toBeUndefined();
  });
  it("replaces and revokes connections with a new cache revision", async () => {
    const access = await import("../src/publisher-access.js");
    const first = access.savePublisherSession("https://publisher.example", "First university", [cookie()]);
    const revision = access.publisherAccessRevision();
    const second = access.savePublisherSession("https://publisher.example", "Second university", [cookie("new-session")]);
    expect(second.id).toBe(first.id);
    expect(access.publisherAccessRevision()).not.toBe(revision);
    expect(access.listPublisherAccess()).toHaveLength(1);
    access.removePublisherAccess(second.id);
    expect(access.publisherCookieForUrl(new URL("https://publisher.example"))).toBeUndefined();
  });
  it("rejects unsafe websites and empty or expired sessions", async () => {
    const access = await import("../src/publisher-access.js");
    for (const url of ["http://publisher.example", "https://u:p@publisher.example", "https://publisher.example:8443", "file:///tmp"])
      expect(() => access.publisherOrigin(url)).toThrow();
    expect(() => access.savePublisherSession("https://publisher.example", "", [cookie("expired", ".publisher.example", { expires: 1 })])).toThrow("No publisher session");
    const launch = vi.fn();
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(access.startPublisherLogin("https://publisher.example", "", launch)).rejects.toThrow("private network");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("user-controlled institution sign-in", () => {
  it("requires return from SSO, saves only on Finish, and closes the browser", async () => {
    const access = await import("../src/publisher-access.js");
    const fixture = fakeBrowser("https://university.example/login");
    const login = await access.startPublisherLogin("https://publisher.example", "Any university", async () => fixture.browser);
    expect(access.listPublisherAccess()).toEqual([]);
    expect(JSON.stringify(access.publisherLoginStatus())).not.toContain("university-secret");
    await expect(access.finishPublisherLogin(login.id)).rejects.toThrow("return to the publisher");
    fixture.navigate("https://publisher.example/article/1");
    const saved = await access.finishPublisherLogin(login.id);
    expect(saved.status).toBe("saved");
    expect(access.publisherLoginStatus()).toBeNull();
    expect(fixture.browser.close).toHaveBeenCalled();
    expect(readFileSync(join(root, "research-secrets", "publisher-access.json"), "utf8")).not.toContain("university-secret");
  });
  it("cancels or expires a login without saving cookies", async () => {
    const access = await import("../src/publisher-access.js");
    const fixture = fakeBrowser();
    const login = await access.startPublisherLogin("https://publisher.example", "", async () => fixture.browser);
    await expect(access.startPublisherLogin("https://publisher.example", "", async () => fixture.browser)).rejects.toThrow("already open");
    await access.cancelPublisherLogin(login.id);
    expect(access.listPublisherAccess()).toEqual([]);
    expect(access.publisherLoginStatus()).toBeNull();
    vi.useFakeTimers();
    await access.startPublisherLogin("https://publisher.example", "", async () => fixture.browser);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(access.publisherLoginStatus()).toBeNull();
    expect(access.listPublisherAccess()).toEqual([]);
  });
  it("does not save after cancellation races with cookie capture", async () => {
    const access = await import("../src/publisher-access.js");
    const fixture = fakeBrowser();
    let complete!: (cookies: Cookie[]) => void;
    fixture.context.cookies.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const login = await access.startPublisherLogin("https://publisher.example", "", async () => fixture.browser);
    const finished = access.finishPublisherLogin(login.id).catch(error => error);
    await access.cancelPublisherLogin(login.id);
    complete([cookie()]);
    expect(await finished).toMatchObject({ message: expect.stringContaining("cancelled or expired") });
    expect(access.listPublisherAccess()).toEqual([]);
  });
});
