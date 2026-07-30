import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * In-app replacements for the native alert()/confirm() dialogs, styled to the
 * ink-and-paper theme. Mount <DialogProvider> once (App does), then:
 *
 *   const dialog = useDialog();
 *   if (await dialog.confirm({ title: "Remove this?", danger: true })) { … }
 *   await dialog.alert({ title: "Done", body: "…" });
 */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** Label for the confirming button (default "Confirm"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action — the confirm button renders in pencil red. */
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  body?: ReactNode;
  dismissLabel?: string;
}

interface DialogApi {
  /** Resolves true when confirmed, false when cancelled or dismissed. */
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Resolves when the notice is dismissed. */
  alert(opts: AlertOptions): Promise<void>;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void; restoreTo: HTMLElement | null }
  | { kind: "alert"; opts: AlertOptions; resolve: () => void; restoreTo: HTMLElement | null };

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside <DialogProvider>");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const current = queue[0] ?? null;

  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const push = useCallback((p: Pending) => setQueue((q) => [...q, p]), []);

  /** Close the current dialog, resolve its promise, and put focus back. */
  const settle = useCallback((ok: boolean) => {
    const head = queueRef.current[0];
    if (!head) return;
    setQueue((q) => q.slice(1));
    if (head.kind === "confirm") head.resolve(ok);
    else head.resolve();
    const el = head.restoreTo;
    if (el && el.isConnected) setTimeout(() => el.focus(), 0);
  }, []);

  const api = useMemo<DialogApi>(() => {
    const opener = () =>
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return {
      confirm: (opts) =>
        new Promise<boolean>((resolve) =>
          push({ kind: "confirm", opts, resolve, restoreTo: opener() }),
        ),
      alert: (opts) =>
        new Promise<void>((resolve) =>
          push({ kind: "alert", opts, resolve, restoreTo: opener() }),
        ),
    };
  }, [push]);

  // The primary button takes focus whenever a dialog opens.
  useEffect(() => {
    if (current) primaryRef.current?.focus();
  }, [current]);

  // Escape cancels; Tab loops between the two buttons (a minimal focus trap).
  // Capture phase on window, so modals underneath (Settings closes itself on
  // Escape via its own window listener) never see the key while a dialog is up.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
      } else if (e.key === "Tab") {
        const stops = [cancelRef.current, primaryRef.current].filter(
          (b): b is HTMLButtonElement => b !== null,
        );
        if (stops.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = stops.indexOf(document.activeElement as HTMLButtonElement);
        stops[(idx + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, settle]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-[2px]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={current.opts.body ? bodyId : undefined}
            className="dialog-card w-[400px] max-w-full rounded-lg border border-rule bg-ink-2 p-5 shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
          >
            <h2 id={titleId} className="font-serif text-[17px] font-semibold text-paper">
              {current.opts.title}
            </h2>
            {current.opts.body && (
              <div
                id={bodyId}
                className="mt-2 font-serif text-[13.5px] leading-relaxed text-paper-dim"
              >
                {current.opts.body}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              {current.kind === "confirm" && (
                <button
                  ref={cancelRef}
                  onClick={() => settle(false)}
                  className="rounded border border-rule px-3.5 py-1.5 text-[13px] text-paper-dim transition-colors hover:border-graphite hover:text-paper"
                >
                  {current.opts.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                ref={primaryRef}
                onClick={() => settle(true)}
                className={`rounded px-3.5 py-1.5 text-[13px] font-medium text-paper transition-colors ${
                  current.kind === "confirm" && current.opts.danger
                    ? "bg-pencil hover:bg-pencil/80"
                    : "bg-leaf-deep hover:bg-leaf"
                }`}
              >
                {current.kind === "confirm"
                  ? (current.opts.confirmLabel ?? "Confirm")
                  : (current.opts.dismissLabel ?? "OK")}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
