/**
 * The Source editor's save rules (web/src/source-save.ts): every save names
 * the text it was typed over, a 409 keeps the draft, and autosave never runs
 * over a file that changed on disk or for a restored draft nobody touched.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CONFLICT_MARK,
  saveBase,
  saveWithBase,
  shouldAutosave,
  type AutosaveState,
} from "../../web/src/source-save.js";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("saveBase", () => {
  it("sends the base the draft was typed over", () => {
    expect(saveBase("old disk", "old disk", false)).toBe("old disk");
    // The disk moved under the draft: the draft's own base, so the server refuses.
    expect(saveBase("old disk", "new disk", false)).toBe("old disk");
  });

  it("falls back to the last fetched text when there is no draft record", () => {
    expect(saveBase(undefined, "disk", false)).toBe("disk");
  });

  it("Save mine names the disk text the user was shown", () => {
    expect(saveBase("old disk", "new disk", true)).toBe("new disk");
  });
});

describe("shouldAutosave", () => {
  const base: AutosaveState = {
    enabled: true,
    text: "draft",
    saved: "disk",
    diskChanged: false,
    userTyped: true,
    busy: false,
    saving: false,
  };

  it("saves a typed draft over an unchanged file", () => {
    expect(shouldAutosave(base)).toBe(true);
  });

  it("never runs while the changed-on-disk notice shows", () => {
    expect(shouldAutosave({ ...base, diskChanged: true })).toBe(false);
  });

  it("never re-saves a restored draft before the user types", () => {
    expect(shouldAutosave({ ...base, userTyped: false })).toBe(false);
  });

  it("respects the toggle, a running turn, a save in flight, a clean doc and conflict markers", () => {
    expect(shouldAutosave({ ...base, enabled: false })).toBe(false);
    expect(shouldAutosave({ ...base, busy: true })).toBe(false);
    expect(shouldAutosave({ ...base, saving: true })).toBe(false);
    expect(shouldAutosave({ ...base, text: "disk" })).toBe(false);
    expect(shouldAutosave({ ...base, text: `a\n${CONFLICT_MARK}\nb` })).toBe(false);
  });
});

describe("saveWithBase", () => {
  it("passes the base to the save and returns the diff", async () => {
    const save = vi.fn(async () => ({ diff: "D" }));
    const fetchDisk = vi.fn(async () => "unused");
    expect(await saveWithBase({ save, fetchDisk }, "B")).toEqual({ kind: "saved", diff: "D" });
    expect(save).toHaveBeenCalledWith("B");
    expect(fetchDisk).not.toHaveBeenCalled();
  });

  it("turns a refused save over a changed file into a conflict with the disk text", async () => {
    const outcome = await saveWithBase(
      { save: async () => { throw httpError(409, "changed"); }, fetchDisk: async () => "agent edit" },
      "what I typed over",
    );
    expect(outcome).toEqual({ kind: "conflict", disk: "agent edit" });
  });

  it("a 409 for another reason (agent turn running) stays an error", async () => {
    const outcome = await saveWithBase(
      { save: async () => { throw httpError(409, "agent turn in progress"); }, fetchDisk: async () => "B" },
      "B",
    );
    expect(outcome).toEqual({ kind: "error", message: "agent turn in progress" });
  });

  it("reports other failures, and a conflict whose disk text cannot be read", async () => {
    expect(
      await saveWithBase({ save: async () => { throw httpError(500, "boom"); }, fetchDisk: async () => "x" }, "B"),
    ).toEqual({ kind: "error", message: "boom" });
    const gone = await saveWithBase(
      { save: async () => { throw httpError(409, "changed"); }, fetchDisk: async () => { throw new Error("no such file"); } },
      "B",
    );
    expect(gone.kind).toBe("error");
    expect(gone.kind === "error" && gone.message).toContain("no such file");
  });
});
