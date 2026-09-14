import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl } from "../../web/src/urls.js";
afterEach(() => vi.unstubAllEnvs());
describe("hosted app URLs", () => {
  it("keeps API, download, and asset URLs under a configured prefix", () => {
    vi.stubEnv("BASE_URL", "/blattbot/");
    expect(appUrl("/api/projects/a/pdf?v=1")).toBe("/blattbot/api/projects/a/pdf?v=1");
    expect(appUrl("/api/ws?project=a")).toBe("/blattbot/api/ws?project=a");
    expect(appUrl("/logo.svg")).toBe("/blattbot/logo.svg");
  });
  it("preserves the normal local root install", () => {
    vi.stubEnv("BASE_URL", "/");
    expect(appUrl("/api/bootstrap")).toBe("/api/bootstrap");
  });
});
