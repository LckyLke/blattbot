/**
 * The tab-close guard and the leave dialog's wording (web/src/leave-guard.ts),
 * plus the remembered Proof mode (web/src/ui-memory.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { draftLeaveNotice, shouldWarnOnUnload } from "../../web/src/leave-guard.js";
import { configureUiStorage, loadProofMode, readUiPref, saveProofMode, writeUiPref } from "../../web/src/ui-memory.js";

describe("shouldWarnOnUnload", () => {
  const calm = { busy: false, unpersistedDrafts: 0, savesInFlight: 0 };

  it("stays quiet when nothing would be lost (pending changes are on disk, drafts are stored)", () => {
    expect(shouldWarnOnUnload(calm)).toBe(false);
  });

  it("warns for a running turn, a save in flight, or drafts storage could not keep", () => {
    expect(shouldWarnOnUnload({ ...calm, busy: true })).toBe(true);
    expect(shouldWarnOnUnload({ ...calm, savesInFlight: 1 })).toBe(true);
    expect(shouldWarnOnUnload({ ...calm, unpersistedDrafts: 2 })).toBe(true);
  });
});

describe("draftLeaveNotice", () => {
  it("says drafts survive a reload", () => {
    const text = draftLeaveNotice(2, 0, "Paper");
    expect(text).toContain("2 files of “Paper”");
    expect(text).toContain("also across a reload");
    expect(text).not.toMatch(/lose/);
  });

  it("names the drafts a reload would still lose", () => {
    expect(draftLeaveNotice(1, 1, "Paper")).toContain("That draft is too large for browser storage");
    expect(draftLeaveNotice(3, 1, "Paper")).toContain("1 of them is too large");
    expect(draftLeaveNotice(3, 3, "Paper")).toContain("These drafts are");
  });
});

describe("remembered Proof mode", () => {
  afterEach(() => configureUiStorage(null));

  it("defaults to the text diff and remembers the choice per project", () => {
    const map = new Map<string, string>();
    configureUiStorage({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) });
    expect(loadProofMode("p1")).toBe("text");
    saveProofMode("p1", "rendered");
    expect(loadProofMode("p1")).toBe("rendered");
    expect(loadProofMode("p2")).toBe("text");
    // Junk falls back to the default.
    map.set("blattbot.proofMode:p3", "pixels");
    expect(loadProofMode("p3")).toBe("text");
  });

  it("never throws when storage is off or refuses", () => {
    configureUiStorage({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => saveProofMode("p1", "rendered")).not.toThrow();
    expect(loadProofMode("p1")).toBe("text");
    configureUiStorage(null);
    expect(readUiPref("x")).toBeNull();
    expect(() => writeUiPref("x", "1")).not.toThrow();
  });
});
