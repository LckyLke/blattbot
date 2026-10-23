/**
 * The newest discard's restore point per project, kept in this browser so
 * Proof can offer "Restore last discard" until the next discard (or a reload).
 * The server keeps the restore points themselves (refs/blattbot/discard/…).
 */

export interface LastDiscard {
  id: string;
  /** What was discarded, for the button's tooltip. */
  label: string;
}

const key = (projectId: string) => `blattbot.lastDiscard.${projectId}`;

export function readLastDiscard(projectId: string): LastDiscard | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(projectId)) ?? "null");
    return raw && typeof raw.id === "string" && typeof raw.label === "string" ? { id: raw.id, label: raw.label } : null;
  } catch {
    return null;
  }
}

export function rememberLastDiscard(projectId: string, last: LastDiscard): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(last));
  } catch {
    /* storage unavailable: the in-memory copy still works */
  }
}

export function forgetLastDiscard(projectId: string, id?: string): void {
  try {
    if (id && readLastDiscard(projectId)?.id !== id) return;
    localStorage.removeItem(key(projectId));
  } catch {
    /* storage unavailable */
  }
}
