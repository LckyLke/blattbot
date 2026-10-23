// "Overleaf changed" detection from the account's project list (fetched
// every minute anyway for the session check): pure helpers, so the rules are
// testable without the hook around them.
import type { OlProject, SyncConflict } from "./api";

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

/** True when timestamp `a` is later than `b` (a missing `b` counts as older). */
export function isLater(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return a !== b;
}

/** The later of two timestamps. */
export function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  return isLater(b, a) ? b : a;
}

/**
 * Overleaf's lastUpdated for the project when it is later than what the
 * local mirror last saw (`seen`, from the last sync or push); null when
 * nothing changed — or when either side is unknown, which is no evidence.
 */
export function remoteChangedAt(
  listing: OlProject[],
  remoteProjectId: string | undefined,
  seen: string | undefined,
): string | null {
  if (!remoteProjectId || !seen) return null;
  const listed = listing.find((p) => p.id === remoteProjectId)?.lastUpdated;
  return listed && isLater(listed, seen) ? listed : null;
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
