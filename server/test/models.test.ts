/** The model pick-list normalizer and its static fallback (server/src/models.ts). */
import { describe, expect, it } from "vitest";
import { normalizeModelInfo, staticModelList } from "../src/models.js";

describe("normalizeModelInfo", () => {
  it("offers the resolved concrete ids with the engine's labels, then BlattBot's aliases", () => {
    // The shape observed live from CLI 2.1.258's picker rows.
    const rows = [
      { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5[1m]" },
      { value: "opus[1m]", displayName: "Opus (1M context)", resolvedModel: "claude-opus-5[1m]", description: "Opus 5 with 1M context", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
      { value: "claude-fable-5-1[1m]", displayName: "Fable", resolvedModel: "claude-fable-5-1", supportsEffort: true },
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
      { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" },
      { value: "", displayName: "junk" },
      null,
    ];
    const list = normalizeModelInfo(rows);
    expect(list.slice(0, 4)).toEqual([
      { id: "claude-opus-5[1m]", label: "Opus (1M context)", description: "Opus 5 with 1M context", supportsEffort: true, effortLevels: ["low", "high", "max"] },
      { id: "claude-fable-5-1", label: "Fable", supportsEffort: true },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku" },
    ]);
    expect(list.find((m) => m.id === "fable")).toEqual({ id: "fable", resolvesTo: "claude-fable-5-1", label: "fable → claude-fable-5-1" });
  });

  it("returns an empty list for junk (so the caller falls back)", () => {
    expect(normalizeModelInfo(undefined)).toEqual([]);
    expect(normalizeModelInfo({})).toEqual([]);
    expect(normalizeModelInfo([{ value: "default" }])).toEqual([]);
  });
});

describe("staticModelList", () => {
  it("lists the alias targets once, then the aliases", () => {
    const { models, source } = staticModelList();
    expect(source).toBe("static");
    const ids = models.map((m) => m.id);
    expect(ids.filter((i) => i === "claude-sonnet-5")).toHaveLength(1);
    expect(models.find((m) => m.id === "fable")).toEqual({ id: "fable", resolvesTo: "claude-fable-5-1", label: "fable → claude-fable-5-1" });
  });
});
