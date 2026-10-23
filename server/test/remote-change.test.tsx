import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { changeTime, remoteChangeAction, syncConflicts } from "../../web/src/remote-change.js";
import { applyChatEvent } from "../../web/src/chat-events.js";
import ConflictBanner from "../../web/src/components/ConflictBanner.js";

describe("Overleaf change detection", () => {
  const seen = "2026-10-23T10:00:00.000Z";

  it("syncs on its own only when nothing local is pending", () => {
    expect(remoteChangeAction("2026-10-23T10:05:00.000Z", true)).toBe("sync");
    expect(remoteChangeAction("2026-10-23T10:05:00.000Z", false)).toBe("notice");
    expect(remoteChangeAction(null, true)).toBeNull();
    expect(remoteChangeAction(null, false)).toBeNull();
  });

  it("formats the time a change was noticed", () => {
    expect(changeTime(seen)).toMatch(/\d{1,2}.\d{2}/);
    expect(changeTime("garbage")).toBe("");
  });

  it("reads the overlapping files from sync and approve results", () => {
    const detail = [{ path: "main.tex", kind: "modified" as const, hunks: [{ line: 3, remote: "R", base: "B", mine: "M" }] }];
    expect(syncConflicts({ conflicts: detail, drift: ["main.tex"] })).toBe(detail);
    expect(syncConflicts({ drift: ["a.tex"] })).toEqual([{ path: "a.tex", kind: "modified" }]);
    expect(syncConflicts({ conflicts: [], drift: [] })).toBeNull();
    expect(syncConflicts(undefined)).toBeNull();
  });
});

describe("conflict banner", () => {
  const noop = () => {};
  const base = { locked: false, acting: null, onKeepOverleaf: noop, onResolveInEditor: noop, onOverwrite: noop, onOverwriteAll: noop };
  const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("shows what each side changed and per-file actions; bulk actions name all files", () => {
    const html = renderToStaticMarkup(
      <ConflictBanner
        {...base}
        source="approve"
        overleaf
        conflicts={[
          { path: "main.tex", kind: "modified", hunks: [{ line: 3, remote: "Remote edit.", base: "Body.", mine: "Local edit." }] },
          { path: "fig.png", kind: "modified", binary: true },
          { path: "refs.bib", kind: "deleted-remote" },
        ]}
      />,
    );
    const plain = text(html);
    expect(plain).toContain("Overleaf changed 3 files you also edited — nothing was pushed");
    expect(plain).toContain("line 3");
    expect(plain).toMatch(/Overleaf Remote edit\. Before Body\. Yours Local edit\./);
    expect(plain).toContain("1 overlapping change");
    expect(plain).toContain("not a text file");
    expect(plain).toContain("deleted on Overleaf, edited here");
    // Per file; "Resolve in editor" only where a line merge is possible.
    expect(html.match(/Keep Overleaf&#x27;s version of main\.tex/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Resolve main.tex in the editor"');
    expect(html).not.toContain('aria-label="Resolve fig.png in the editor"');
    expect(html).toContain('aria-label="Overwrite refs.bib on Overleaf"');
    expect(plain).toContain("Keep Overleaf's version of all 3 files");
    expect(plain).toContain("Overwrite Overleaf with all 3 files");
  });

  it("words a sync's drift and Git conflicts differently, without bulk buttons for one file", () => {
    const drift = text(renderToStaticMarkup(<ConflictBanner {...base} source="sync" overleaf conflicts={[{ path: "a.tex", kind: "modified" }]} />));
    expect(drift).toContain("Overleaf also changed 1 file you edited — the edits overlap");
    expect(drift).not.toContain("all 1 files");
    const gitHtml = renderToStaticMarkup(<ConflictBanner {...base} source="sync" overleaf={false} conflicts={[{ path: "a.tex", kind: "unmerged" }]} />);
    expect(text(gitHtml)).toContain("A sync left Git conflicts in 1 file");
    expect(gitHtml).toContain('aria-label="Resolve a.tex in the editor"');
    expect(gitHtml).not.toContain("Keep Overleaf");
    expect(gitHtml).not.toContain("Overwrite");
  });

  it("tells the chat what an approve merged and left overlapping", () => {
    const items = applyChatEvent([], { type: "approved", pushed: true, mergedRemote: ["main.tex"], drift: ["refs.bib"] }, { uid: "u", projectKind: "overleaf" });
    expect(items.map((i: any) => i.text)).toEqual([
      "Changes pushed to Overleaf.",
      "Merged Overleaf's edits to main.tex with yours, line by line.",
      "Overleaf also changed refs.bib where you have pending edits — see Proof.",
    ]);
  });
});
