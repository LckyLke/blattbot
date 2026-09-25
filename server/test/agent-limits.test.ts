import { describe, expect, it } from "vitest";
import { normalizeLimits } from "../src/agent-limits.js";
import { toolDetail } from "../src/backends/types.js";

describe("account usage limits", () => {
  it("prefers all named buckets over the legacy duplicate", () => {
    expect(normalizeLimits({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: { usedPercent: 90, windowDurationMins: 10080 } },
        other: { limitName: "Other model", primary: { usedPercent: 0, windowDurationMins: 60 } },
      },
    })).toEqual([
      { bucket: "codex", window: "5 hour", remainingPercent: 75, resetsAt: 1800000000 },
      { bucket: "codex", window: "1 week", remainingPercent: 10 },
      { bucket: "Other model", window: "1 hour", remainingPercent: 100 },
    ]);
  });
  it("distinguishes missing values from exhausted limits and clamps provider values", () => {
    expect(normalizeLimits({ rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: 120 } } }))
      .toEqual([{ bucket: "codex", window: "Secondary", remainingPercent: 0 }]);
    expect(normalizeLimits({ rateLimits: null })).toEqual([]);
    expect(normalizeLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: NaN } } } })).toEqual([]);
  });
});

describe("recorded tool details", () => {
  it("preserves structured claims and multiline evidence with explicit truncation", () => {
    const claims = { claims: [{ key: "smith2025", claim: "Exact claim" }] };
    expect(JSON.parse(toolDetail(claims))).toEqual(claims);
    expect(toolDetail("Evidence\nPage 2")).toBe("Evidence\nPage 2");
    expect(toolDetail("x".repeat(100001))).toBe("x".repeat(100000) + "\n[Output truncated at 100,000 characters]");
  });
});
