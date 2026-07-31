/**
 * Update-available check: the semver comparison, the cached registry lookup
 * (stubbed fetch — the real registry is never hit), and the package-hygiene
 * guarantees (no accidental self-dependency, version bumped).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  vi.resetModules();
});

describe("isNewerVersion", () => {
  it("compares major.minor.patch numerically", async () => {
    const { isNewerVersion } = await import("../src/version.js");
    expect(isNewerVersion("0.2.0", "0.2.1")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.3.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(false);
    // Numeric, not lexicographic.
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(true);
    // Tolerates a v prefix and short versions.
    expect(isNewerVersion("v0.2.0", "v0.2.1")).toBe(true);
    expect(isNewerVersion("0.2", "0.2.1")).toBe(true);
    // Garbage never reports an update.
    expect(isNewerVersion("0.2.0", "not-a-version")).toBe(false);
  });
});

describe("checkLatestVersion", () => {
  it("returns the registry version and caches it for later calls", async () => {
    const { checkLatestVersion, resetVersionCache } = await import("../src/version.js");
    resetVersionCache();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: "blattbot", version: "9.9.9" }),
    })) as unknown as typeof fetch;
    expect(await checkLatestVersion(fetchMock)).toBe("9.9.9");
    expect(await checkLatestVersion(fetchMock)).toBe("9.9.9");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock as any).mock.calls[0][0]).toBe("https://registry.npmjs.org/blattbot/latest");
  });

  it("swallows failures into null — and caches the failure too", async () => {
    const { checkLatestVersion, resetVersionCache } = await import("../src/version.js");
    resetVersionCache();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await checkLatestVersion(fetchMock)).toBeNull();
    expect(await checkLatestVersion(fetchMock)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats HTTP errors and malformed bodies as unknown", async () => {
    const { checkLatestVersion, resetVersionCache } = await import("../src/version.js");
    resetVersionCache();
    const bad = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await checkLatestVersion(bad)).toBeNull();
    resetVersionCache();
    const weird = vi.fn(async () => ({ ok: true, json: async () => ({ version: 42 }) })) as unknown as typeof fetch;
    expect(await checkLatestVersion(weird)).toBeNull();
  });
});

describe("package hygiene", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

  it("has no self-dependency", () => {
    expect(pkg.name).toBe("blattbot");
    expect(pkg.dependencies?.blattbot).toBeUndefined();
    expect(pkg.devDependencies?.blattbot).toBeUndefined();
  });

  it("carries a semver version that currentVersion() reads back", async () => {
    // Deliberately not a literal: pinning the number here would fail every
    // release. The invariant is that the runtime reports what package.json says.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const { currentVersion } = await import("../src/version.js");
    expect(currentVersion()).toBe(pkg.version);
  });
});
