/** Dashboard / sidebar project status and the Open-in-Overleaf link (web/src/project-status.ts). */
import { describe, expect, it } from "vitest";
import { overleafProjectUrl, projectStatus, statusSuffix, timeAgo } from "../../web/src/project-status.js";

describe("overleafProjectUrl", () => {
  const ol = { kind: "overleaf" as const, overleafBaseUrl: "https://www.overleaf.com", overleafProjectId: "0123456789abcdef01234567" };

  it("links Overleaf projects to /project/<id> on their instance", () => {
    expect(overleafProjectUrl(ol)).toBe("https://www.overleaf.com/project/0123456789abcdef01234567");
    expect(overleafProjectUrl({ ...ol, overleafBaseUrl: "https://latex.example.org/sub/" })).toBe(
      "https://latex.example.org/sub/project/0123456789abcdef01234567",
    );
  });

  it("is absent for other kinds, missing ids and non-web URLs", () => {
    expect(overleafProjectUrl({ ...ol, kind: "git" })).toBeNull();
    expect(overleafProjectUrl({ ...ol, kind: "local" })).toBeNull();
    expect(overleafProjectUrl({ ...ol, overleafProjectId: undefined })).toBeNull();
    expect(overleafProjectUrl({ ...ol, overleafBaseUrl: "javascript:alert(1)" })).toBeNull();
    expect(overleafProjectUrl({ ...ol, overleafBaseUrl: "not a url" })).toBeNull();
  });
});

describe("projectStatus", () => {
  const now = Date.parse("2026-05-01T12:00:00Z");

  it("reads the polled list fields", () => {
    expect(projectStatus({ turnActive: true, pendingFiles: 3 }, undefined, now)).toEqual({
      working: true,
      pending: 3,
      synced: null,
    });
    expect(projectStatus({}, undefined, now)).toEqual({ working: false, pending: 0, synced: null });
  });

  it("prefers the open project's live values", () => {
    expect(projectStatus({ turnActive: false, pendingFiles: 9 }, { working: true, pending: 1 }, now)).toMatchObject({
      working: true,
      pending: 1,
    });
  });

  it("shows the last sync when the server reports one", () => {
    expect(projectStatus({ lastSyncAt: "2026-05-01T11:55:00Z" }, undefined, now).synced).toBe("synced 5 min ago");
    expect(projectStatus({ lastSyncAt: "garbage" }, undefined, now).synced).toBeNull();
  });

  it("words the switcher suffix", () => {
    expect(statusSuffix({ working: false, pending: 0, synced: null })).toBe("");
    expect(statusSuffix({ working: true, pending: 2, synced: null })).toBe(" — agent working · 2 pending files");
    expect(statusSuffix({ working: false, pending: 1, synced: "synced just now" })).toBe(" — 1 pending file");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-05-01T12:00:00Z");
  it("rounds to a readable unit", () => {
    expect(timeAgo("2026-05-01T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-05-01T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-04-28T12:00:00Z", now)).toBe("3 d ago");
    expect(timeAgo(undefined, now)).toBeNull();
  });
});
