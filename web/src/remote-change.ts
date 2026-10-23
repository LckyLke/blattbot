// "Overleaf changed" handling for the minute check in useProjectSync: pure
// helpers, so the rules are testable without the hook around them.
import type { SyncConflict } from "./api";

/**
 * The overlapping files a sync or approve result (or its websocket event)
 * reports: per-file detail when the server sent it, else just the drift
 * paths; null when there are none.
 */
export function syncConflicts(result: { conflicts?: unknown; drift?: unknown } | null | undefined): SyncConflict[] | null {
  if (Array.isArray(result?.conflicts) && result.conflicts.length > 0) return result.conflicts as SyncConflict[];
  if (Array.isArray(result?.drift) && result.drift.length > 0) {
    return result.drift.filter((p): p is string => typeof p === "string").map((path) => ({ path, kind: "modified" as const }));
  }
  return null;
}

/**
 * What to do about a remote change: sync right away when nothing local can
 * be affected (no pending changes, no running turn), otherwise tell the user
 * and let them choose when.
 */
export function remoteChangeAction(changedAt: string | null, idle: boolean): "sync" | "notice" | null {
  if (!changedAt) return null;
  return idle ? "sync" : "notice";
}

/** "14:05"-style local time of an ISO timestamp (empty when unparsable). */
export function changeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
