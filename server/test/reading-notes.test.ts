import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textPdf } from "./fixtures/pdf.js";
let root: string, dir: string;
const quote = "Accuracy was 91 percent on dataset A.";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reading-notes-"));
  dir = join(root, "project");
  mkdirSync(dir);
  vi.stubEnv("BLATTBOT_DATA_DIR", root);
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  writeFileSync(
    join(dir, "refs.bib"),
    "@article{alpha,title={Graph Models},year={2020}}",
  );
  writeFileSync(
    join(dir, "alpha.pdf"),
    textPdf([
      "Graph Models\nIntroduction\nWe study graph models.",
      quote,
      "References\n[1] A paper claims 100 percent on every dataset.",
    ]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
describe("paper reading notes", () => {
  it("persists page-linked notes, prevents lost updates, and supports undoing removal", async () => {
    const n = await import("../src/research/reading.js");
    const note = n.saveReadingNote("p1", dir, {
      key: "alpha",
      text: "A result",
      page: 2,
      quote,
    });
    expect(n.readingNotes("p1", dir, "alpha")).toHaveLength(1);
    expect(n.readingNotes("other", dir)).toEqual([]);
    const edit = n.saveReadingNote("p1", dir, {
      ...note,
      text: "A qualified result",
    });
    expect(() =>
      n.saveReadingNote("p1", dir, { ...note, text: "Stale tab" }),
    ).toThrow("changed elsewhere");
    const removed = n.archiveReadingNote(
      "p1",
      dir,
      edit.id,
      edit.revision,
      true,
    );
    expect(n.readingNotes("p1", dir)).toEqual([]);
    n.archiveReadingNote("p1", dir, removed.id, removed.revision, false);
    expect(n.readingNotes("p1", dir)[0].text).toBe("A qualified result");
  });
  it("checks only supplied non-bibliography excerpts, records quotes and never overwrites the note", async () => {
    const n = await import("../src/research/reading.js");
    const note = n.saveReadingNote("p1", dir, {
      key: "alpha",
      text: "91 percent accuracy on A",
      page: 2,
    });
    const call = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain("100 percent on every dataset");
      return JSON.stringify({
        verdict: "consistent",
        explanation: "Same metric and dataset.",
        quotes: [{ page: 2, quote }],
        suggestedRevision:
          "The paper reports 91 percent accuracy on dataset A.",
      });
    });
    const checked = await n.checkReadingNote(
      "p1",
      dir,
      note.id,
      note.revision,
      call,
    );
    expect(checked.text).toBe(note.text);
    expect(checked.assessment?.quotes).toEqual([{ page: 2, quote }]);
    expect(checked.assessmentStale).toBe(false);
    const edited = n.saveReadingNote("p1", dir, {
      ...checked,
      text: "100 percent accuracy",
    });
    expect(edited.assessmentStale).toBe(true);
  });
  it("downgrades invented quotes and clears an unsupported rewrite", async () => {
    const n = await import("../src/research/reading.js");
    const note = n.saveReadingNote("p1", dir, {
      key: "alpha",
      text: "Perfect accuracy",
    });
    const checked = await n.checkReadingNote(
      "p1",
      dir,
      note.id,
      note.revision,
      async () =>
        JSON.stringify({
          verdict: "consistent",
          explanation: "Perfect",
          quotes: [{ page: 2, quote: "Perfect accuracy on every dataset." }],
          suggestedRevision: "It always works.",
        }),
    );
    expect(checked.assessment).toMatchObject({
      verdict: "unclear",
      quotes: [],
      suggestedRevision: "",
    });
  });
  it("rejects a late check when the note changed during the agent call", async () => {
    const n = await import("../src/research/reading.js");
    const note = n.saveReadingNote("p1", dir, {
      key: "alpha",
      text: "Initial note",
    });
    await expect(
      n.checkReadingNote("p1", dir, note.id, note.revision, async () => {
        n.saveReadingNote("p1", dir, { ...note, text: "My newer note" });
        return JSON.stringify({
          verdict: "consistent",
          explanation: "A result",
          quotes: [{ page: 2, quote }],
        });
      }),
    ).rejects.toThrow("changed during");
    expect(n.readingNotes("p1", dir)[0].text).toBe("My newer note");
    expect(n.readingNotes("p1", dir)[0].assessment).toBeUndefined();
  });
  it("marks a check stale when the source PDF changes", async () => {
    const n = await import("../src/research/reading.js");
    const note = n.saveReadingNote("p1", dir, {
      key: "alpha",
      text: "91 percent",
    });
    await n.checkReadingNote("p1", dir, note.id, note.revision, async () =>
      JSON.stringify({
        verdict: "consistent",
        explanation: "Matches",
        quotes: [{ page: 2, quote }],
      }),
    );
    writeFileSync(
      join(dir, "alpha.pdf"),
      textPdf(["Graph Models\nA revised experiment reached only 80 percent."]),
    );
    expect(n.readingNotes("p1", dir)[0].assessmentStale).toBe(true);
  });
});
