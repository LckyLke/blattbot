/** The History panel's pure helpers and the Proof's default commit message (web modules). */
import { describe, expect, it } from "vitest";
import type { HistoryCommit } from "../../web/src/api.js";
import type { ChatItem } from "../../web/src/chat-events.js";
import {
  changeSummary,
  dayLabel,
  filterLabel,
  groupByDay,
  kindLabel,
  matchesFilter,
  newIncoming,
  seenKey,
} from "../../web/src/history.js";
import { defaultApproveMessage, partMessage } from "../../web/src/approve-message.js";

const commit = (sha: string, kind: HistoryCommit["kind"], time: string): HistoryCommit => ({
  sha,
  short: sha.slice(0, 7),
  kind,
  subject: sha,
  body: "",
  author: { name: "A", email: "a@x" },
  time,
  parents: ["p"],
  files: [{ path: "main.tex", additions: 2, deletions: 1 }],
  additions: 2,
  deletions: 1,
});

describe("history helpers", () => {
  const now = new Date(2026, 9, 23, 15, 0);
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 30).toISOString();

  it("groups the timeline by local day, keeping its order", () => {
    const commits = [
      commit("c5", "sync", at(23, 14)),
      commit("c4", "approve", at(23, 9)),
      commit("c3", "sync", at(22, 20)),
      commit("c2", "local", at(20, 8)),
      commit("c1", "other", "not a date"),
    ];
    const groups = groupByDay(commits, now);
    expect(groups.map((g) => [g.label, g.commits.map((c) => c.sha)])).toEqual([
      ["Today", ["c5", "c4"]],
      ["Yesterday", ["c3"]],
      [dayLabel(new Date(2026, 9, 20), now), ["c2"]],
      ["Unknown date", ["c1"]],
    ]);
    expect(groups[2].key).toBe("2026-10-20");
    // Another year shows the year.
    expect(dayLabel(new Date(2025, 0, 2), now)).toMatch(/2025/);
    expect(dayLabel(new Date(2026, 0, 2), now)).not.toMatch(/2026/);
  });

  it("filters incoming changes and the user's own pushes", () => {
    const kinds = ["sync", "approve", "local", "revert", "other"] as const;
    expect(kinds.filter((k) => matchesFilter(k, "sync"))).toEqual(["sync"]);
    expect(kinds.filter((k) => matchesFilter(k, "mine"))).toEqual(["approve", "local", "revert"]);
    expect(kinds.filter((k) => matchesFilter(k, "all"))).toEqual([...kinds]);
    expect(filterLabel("sync", "overleaf")).toBe("From Overleaf");
    expect(filterLabel("sync", "git")).toBe("From remote");
    expect(filterLabel("mine", "overleaf")).toBe("Pushed by me");
    expect(filterLabel("mine", "local")).toBe("My commits");
    expect(kindLabel("sync", "overleaf")).toBe("From Overleaf");
    expect(kindLabel("approve", "git")).toBe("Pushed by you");
  });

  it("marks incoming commits newer than the last one seen", () => {
    const commits = [
      commit("c4", "sync", at(23, 14)),
      commit("c3", "approve", at(23, 13)),
      commit("c2", "sync", at(23, 12)),
      commit("c1", "sync", at(23, 11)),
    ];
    expect([...newIncoming(commits, "c1")]).toEqual(["c4", "c2"]);
    expect([...newIncoming(commits, "c4")]).toEqual([]);
    expect([...newIncoming(commits, null)]).toEqual([]);
    expect([...newIncoming(commits, "gone")]).toEqual([]);
    expect(changeSummary(commits[0])).toBe("1 file · +2 −1");
    expect(seenKey("p1")).toBe("blattbot.historySeen.p1");
  });
});

describe("default approve message", () => {
  let n = 0;
  const item = (data: Record<string, unknown>) => ({ uid: `u${n++}`, ...data }) as ChatItem;
  const user = (text: string) => item({ kind: "user", text });
  const edit = () => item({ kind: "tool", name: "Edit", detail: "main.tex", status: "done", fileDiff: "diff --git a/x b/x\n" });
  const read = () => item({ kind: "tool", name: "Read", detail: "main.tex", status: "done" });
  const approved = (partial = false) =>
    item({ kind: "notice", tone: "ok", text: "Changes pushed to Overleaf.", source: partial ? "approve-part" : "approve" });

  it("names the latest agent turn that edited files", () => {
    expect(defaultApproveMessage([user("tighten the related-work paragraph\nand more"), edit(), read()])).toBe(
      "Agent: tighten the related-work paragraph",
    );
    // A later conversational turn does not hide the editing one.
    expect(defaultApproveMessage([user("fix the intro"), edit(), user("what does this mean?"), read()])).toBe(
      "Agent: fix the intro",
    );
    // A partial approval leaves the rest of that turn pending.
    expect(defaultApproveMessage([user("fix the intro"), edit(), approved(true)])).toBe("Agent: fix the intro");
    const long = "x".repeat(100);
    const message = defaultApproveMessage([user(long), edit()]);
    expect(message.length).toBe(72);
    expect(message.endsWith("…")).toBe(true);
    expect(defaultApproveMessage([user("   "), edit()])).toBe("Agent edit");
  });

  it("falls back to manual edits after an approval, then to the old default", () => {
    expect(defaultApproveMessage([user("fix the intro"), edit(), approved()])).toBe("Manual edits");
    expect(defaultApproveMessage([user("fix"), edit(), approved(), user("explain"), read()])).toBe("Manual edits");
    expect(defaultApproveMessage([])).toBe("BlattBot edit");
    expect(defaultApproveMessage([user("hi"), read()])).toBe("BlattBot edit");
    // A pending revert names itself.
    expect(defaultApproveMessage([user("fix"), edit()], 'Revert "Agent: fix"')).toBe('Revert "Agent: fix"');
  });

  it("words single-file approvals", () => {
    expect(partMessage("BlattBot edit", "main.tex")).toBe("BlattBot edit: main.tex");
    expect(partMessage("Agent: fix the intro", "main.tex")).toBe("Agent: fix the intro (main.tex)");
  });
});
