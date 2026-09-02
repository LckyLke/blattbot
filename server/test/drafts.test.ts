/**
 * The Source editor's draft store and its fetch-reconcile rule (web/src/drafts.ts).
 *
 * Lives in the server's vitest project like the other web-module tests
 * (chat-composer, markdown): the module is DOM-free, so it runs under node.
 *
 * Background: "sometimes unsaved changes in the source editor get
 * overwritten". Two causes, both covered here through the pure rule the
 * panel now delegates to:
 *   1. A quick save (Ctrl+S) resolved while the user kept typing; the panel
 *      reset its dirty flag on the save result, then the refetch of the saved
 *      file replaced the editor text — the keystrokes typed during the
 *      round-trip were gone.
 *   2. The panel remounts on a pane swap; its state (the draft) died with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureDraftStorage,
  countDrafts,
  draftPaths,
  dropDraft,
  flushDraftPersistence,
  hasDraft,
  hydrateDrafts,
  lastOpenFile,
  MAX_PERSISTED_CHARS,
  readDraft,
  reconcileFetched,
  rememberOpenFile,
  resetDrafts,
  stashDraft,
  subscribeDrafts,
  type DraftStorage,
} from "../../web/src/drafts.js";

/** A Map-backed Storage stand-in (vitest runs these under node, no DOM). */
function fakeStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

describe("reconcileFetched", () => {
  it("replaces a clean editor with the fetched content", () => {
    // Editor == last synced content: nothing of the user's is at stake.
    expect(reconcileFetched("A", "A", "B")).toEqual({ action: "replace" });
    // Identical fetch — still "replace" (a no-op for the caller).
    expect(reconcileFetched("A", "A", "A")).toEqual({ action: "replace" });
  });

  it("keeps text typed during a save round-trip (the overwrite bug)", () => {
    // Save captured "A1"; the user typed on to "A2"; the save's refetch
    // returns "A1". The dirty flag used to be false here, and "A2" was
    // replaced by "A1".
    expect(reconcileFetched("A2", "A1", "A1")).toEqual({
      action: "keep",
      dirty: true,
      changedOnDisk: false,
    });
  });

  it("keeps a draft when the disk moved under it, and says so", () => {
    // Draft over "A"; an agent turn / sync wrote "B".
    expect(reconcileFetched("A-draft", "A", "B")).toEqual({
      action: "keep",
      dirty: true,
      changedOnDisk: true,
    });
  });

  it("marks the draft clean when the disk caught up with it", () => {
    // The user typed exactly what now is on disk (e.g. the agent made the
    // same edit): nothing left to save.
    expect(reconcileFetched("B", "A", "B")).toEqual({
      action: "keep",
      dirty: false,
      changedOnDisk: true,
    });
  });
});

describe("draft store", () => {
  beforeEach(() => resetDrafts());

  it("stashes per project and path, counts per project and overall", () => {
    stashDraft("p1", "main.tex", { content: "x", base: "" });
    stashDraft("p1", "ch/intro.tex", { content: "y", base: "" });
    stashDraft("p2", "main.tex", { content: "z", base: "" });
    expect(countDrafts("p1")).toBe(2);
    expect(countDrafts("p2")).toBe(1);
    expect(countDrafts()).toBe(3);
    expect(draftPaths("p1").sort()).toEqual(["ch/intro.tex", "main.tex"]);
    expect(hasDraft("p2", "main.tex")).toBe(true);
    expect(hasDraft("p2", "ch/intro.tex")).toBe(false);
    expect(readDraft("p1", "main.tex")).toEqual({ content: "x", base: "" });
  });

  it("does not confuse a project id that prefixes another", () => {
    stashDraft("p1", "main.tex", { content: "x", base: "" });
    stashDraft("p10", "main.tex", { content: "x", base: "" });
    expect(countDrafts("p1")).toBe(1);
    expect(draftPaths("p1")).toEqual(["main.tex"]);
  });

  it("notifies subscribers on presence changes only", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDrafts(listener);
    stashDraft("p1", "main.tex", { content: "a", base: "" });
    expect(listener).toHaveBeenCalledTimes(1);
    // Re-stashing (every keystroke) is silent — the count did not change.
    stashDraft("p1", "main.tex", { content: "ab", base: "" });
    expect(listener).toHaveBeenCalledTimes(1);
    dropDraft("p1", "main.tex");
    expect(listener).toHaveBeenCalledTimes(2);
    // Dropping what is not there is silent too.
    dropDraft("p1", "main.tex");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    stashDraft("p1", "main.tex", { content: "a", base: "" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("remembers the open file per project", () => {
    rememberOpenFile("p1", "ch/intro.tex");
    rememberOpenFile("p2", "main.tex");
    expect(lastOpenFile("p1")).toBe("ch/intro.tex");
    expect(lastOpenFile("p2")).toBe("main.tex");
    rememberOpenFile("p1", null);
    expect(lastOpenFile("p1")).toBeUndefined();
  });
});

describe("draft persistence", () => {
  beforeEach(() => {
    configureDraftStorage(null);
    resetDrafts();
  });

  it("writes drafts to storage (debounced) and hydrates them back", () => {
    const store = fakeStorage();
    configureDraftStorage(store);
    stashDraft("p1", "main.tex", { content: "x", base: "" });
    // Debounced: nothing in storage until flushed (or the timer fires).
    expect(store.map.size).toBe(0);
    flushDraftPersistence();
    expect(store.map.size).toBe(1);
    expect([...store.map.keys()][0]).toBe("blattbot.draft:p1\nmain.tex");

    // A fresh page: memory empty, storage full → hydrate restores it.
    resetDrafts(); // also clears storage — so re-seed like a reload would find it
    store.map.set("blattbot.draft:p1\nmain.tex", JSON.stringify({ content: "x", base: "" }));
    expect(countDrafts()).toBe(0);
    expect(hydrateDrafts()).toBe(1);
    expect(readDraft("p1", "main.tex")).toEqual({ content: "x", base: "" });
  });

  it("drops the stored copy when the draft is dropped, and skips junk on hydrate", () => {
    const store = fakeStorage();
    configureDraftStorage(store);
    stashDraft("p1", "a.tex", { content: "1", base: "" });
    flushDraftPersistence();
    dropDraft("p1", "a.tex");
    expect(store.map.size).toBe(0);

    store.map.set("blattbot.draft:p1\nbad.tex", "{not json");
    store.map.set("blattbot.draft:p1\nclean.tex", JSON.stringify({ content: "same", base: "same" }));
    store.map.set("other.key", "ignored");
    expect(hydrateDrafts()).toBe(0);
    // Unusable entries are removed; unrelated keys are left alone.
    expect([...store.map.keys()]).toEqual(["other.key"]);
  });

  it("keeps oversized drafts in memory only", () => {
    const store = fakeStorage();
    configureDraftStorage(store);
    stashDraft("p1", "big.tex", { content: "x".repeat(MAX_PERSISTED_CHARS + 1), base: "" });
    flushDraftPersistence();
    expect(store.map.size).toBe(0);
    expect(hasDraft("p1", "big.tex")).toBe(true);
  });
});
