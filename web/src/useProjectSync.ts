import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Project } from "./api";

type SyncResult = Awaited<ReturnType<typeof api.sync>>;
export interface SyncIssue {
  kind: "session" | "conflict" | "error";
  title: string;
  message: string;
  paths?: string[];
}

function failure(error: unknown): SyncIssue {
  const message = error instanceof Error ? error.message : String(error);
  const expired = /session.*(?:expired|rejected)|reconnect the account/i.test(message);
  return { kind: expired ? "session" : "error", title: expired ? "Overleaf session expired" : "Could not sync project", message };
}

/** One lifecycle per visit: ignore late results after navigation, share pending
 * syncs across visits, and check authentication without pulling every minute. */
export function useProjectSync(project: Project | null, reconnectVersion: number, callbacks: {
  onSynced: (id: string, result: SyncResult, manual: boolean) => void;
  onAccountChanged: () => void;
}) {
  const [state, setState] = useState<{ id: string; syncing: boolean; reconnecting: boolean; issue: SyncIssue | null; popup: boolean } | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const syncs = useRef(new Map<string, Promise<SyncResult>>());
  const actions = useRef({ sync: () => {}, reconnect: (_mode: "import" | "browser") => {}, warn: (_message: string, _paths?: string[]) => {} });
  const id = project?.id, kind = project?.kind, accountId = project?.accountId;

  useEffect(() => {
    if (!id || kind === "local") return;
    let cancelled = false;
    let syncing = false;
    let reconnecting = false;
    let checking = false;
    let revision = 0;
    let issue: SyncIssue | null = null;
    let lastNotice = "";
    const report = (next: SyncIssue) => {
      if (cancelled) return;
      issue = next;
      const signature = next.kind === "session" ? `${next.kind}:${next.title}` : JSON.stringify(next);
      const popup = signature !== lastNotice;
      lastNotice = signature;
      setState(prev => ({ id, syncing, reconnecting, issue, popup: popup || Boolean(prev?.id === id && prev.popup) }));
    };
    const clear = () => {
      issue = null;
      lastNotice = "";
      setState({ id, syncing, reconnecting, issue, popup: false });
    };
    const run = async (manual = false) => {
      if (cancelled || syncing || reconnecting) return;
      revision++;
      syncing = true;
      setState(prev => ({ id, syncing, reconnecting, issue, popup: Boolean(prev?.id === id && prev.popup) }));
      try {
        let pending = syncs.current.get(id);
        if (!pending) {
          pending = api.sync(id);
          syncs.current.set(id, pending);
          const remove = () => { if (syncs.current.get(id) === pending) syncs.current.delete(id); };
          void pending.then(remove, remove);
        }
        const result = await pending;
        if (cancelled) return;
        if (!result.ok) throw new Error(result.output || "Sync did not complete. Try again.");
        callbacksRef.current.onSynced(id, result, manual);
        if (result.drift?.length) {
          report({ kind: "conflict", title: "Sync needs your attention", message: kind === "git"
            ? result.output || "Git conflicts need resolving before you sync again."
            : "Overleaf and your local copy both changed these files. Your local edits were kept. Review the changes before syncing again.", paths: result.drift });
        } else clear();
      } catch (error) {
        if (!cancelled) report(failure(error));
      } finally {
        syncing = false;
        if (!cancelled) setState(prev => prev?.id === id ? { ...prev, syncing: false } : prev);
      }
    };
    const checkSession = async () => {
      if (cancelled || !accountId || kind !== "overleaf" || document.visibilityState === "hidden" || syncing || reconnecting || checking) return;
      checking = true;
      const checkedRevision = revision;
      try {
        await api.accountProjects(accountId);
        if (!cancelled && checkedRevision === revision && issue?.kind === "session") await run();
      } catch (error) {
        // A failed connection check does not imply an expired session. Keep
        // sync/conflict errors until a successful sync actually resolves them.
        const next = failure(error);
        if (!cancelled && checkedRevision === revision && next.kind === "session") report(next);
      } finally { checking = false; }
    };
    actions.current = {
      sync: () => { void run(true); },
      warn: (message, paths) => report(paths?.length
        ? { kind: "conflict", title: "Sync needs your attention", message, paths }
        : failure(new Error(message))),
      reconnect: async mode => {
        if (!accountId || cancelled || reconnecting || syncing) return;
        revision++;
        reconnecting = true;
        setState(prev => prev?.id === id ? { ...prev, reconnecting: true } : prev);
        try {
          await api.refreshAccount(accountId, mode);
          if (cancelled) return;
          callbacksRef.current.onAccountChanged();
          reconnecting = false;
          await run();
        } catch (error) {
          report({ kind: "session", title: "Could not reconnect to Overleaf", message: error instanceof Error ? error.message : String(error) });
        } finally {
          reconnecting = false;
          if (!cancelled) setState(prev => prev?.id === id ? { ...prev, reconnecting: false } : prev);
        }
      },
    };
    clear();
    // Let StrictMode dispose its first effect before sending a mutation.
    void Promise.resolve().then(() => run());
    const timer = setInterval(() => { void checkSession(); }, 60_000);
    const onFocus = () => { void checkSession(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      actions.current = { sync: () => {}, reconnect: () => {}, warn: () => {} };
    };
  }, [id, kind, accountId, reconnectVersion]);

  const syncNow = useCallback(() => actions.current.sync(), []);
  const reconnect = useCallback((mode: "import" | "browser") => actions.current.reconnect(mode), []);
  const reportWarning = useCallback((message: string, paths?: string[]) => actions.current.warn(message, paths), []);
  const dismiss = useCallback(() => setState(prev => prev ? { ...prev, popup: false } : prev), []);
  return { ...(state?.id === id ? state : null), syncNow, reconnect, reportWarning, dismiss };
}
