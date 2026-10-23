import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type PendingRevertInfo } from "./api";
import { seenKey } from "./history";

function loadSeen(projectId: string): string | null {
  try {
    return localStorage.getItem(seenKey(projectId));
  } catch {
    return null;
  }
}

function saveSeen(projectId: string, sha: string): void {
  try {
    localStorage.setItem(seenKey(projectId), sha);
  } catch {
    /* private mode or blocked storage: the badge just resets */
  }
}

interface Status {
  id: string;
  head: string | null;
  unread: number;
  pendingRevert: PendingRevertInfo | null;
}

/**
 * The History tab's state outside the panel: how many commits from Overleaf
 * (or the remote) arrived since the user last opened History, and the
 * reverts waiting in Proof. Opening History marks everything seen; `seenAtOpen`
 * keeps the commit seen before, so the panel can highlight what is new.
 * `stamp` changes whenever the history may have moved (sync, approve, turn end).
 */
export function useHistoryStatus(projectId: string | null, stamp: number, visible: boolean) {
  const [status, setStatus] = useState<Status | null>(null);
  const [seenAtOpen, setSeenAtOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const openFor = useRef<string | null>(null);

  // Opening History: remember what was seen before, for the "new" markers.
  // A layout effect, so it runs before the effect below marks all as seen.
  useLayoutEffect(() => {
    if (!visible || !projectId) {
      openFor.current = null;
      return;
    }
    if (openFor.current === projectId) return;
    openFor.current = projectId;
    setSeenAtOpen(loadSeen(projectId));
  }, [visible, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const seen = loadSeen(projectId);
    api
      .historyStatus(projectId, seen ?? undefined)
      .then((s) => {
        if (cancelled) return;
        // First visit: start counting from now, not from the project's import.
        // Visible: whatever just arrived is on screen.
        if (s.head && (!seen || visibleRef.current)) {
          saveSeen(projectId, s.head);
          setStatus({ id: projectId, ...s, unread: 0 });
          return;
        }
        setStatus({ id: projectId, ...s });
      })
      .catch(() => {
        /* the badge is optional; History itself reports errors */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stamp, nonce]);

  // Shown again later: everything listed now counts as seen.
  useEffect(() => {
    if (!visible || !projectId || status?.id !== projectId || !status.head) return;
    saveSeen(projectId, status.head);
    if (status.unread > 0) setStatus({ ...status, unread: 0 });
  }, [visible, projectId, status]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const current = status?.id === projectId ? status : null;
  return {
    unread: current?.unread ?? 0,
    pendingRevert: current?.pendingRevert ?? null,
    seenAtOpen,
    refresh,
  };
}
