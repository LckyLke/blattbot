import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

/** What a file-tree context menu acts on. */
export type FileMenuTarget = { kind: "file"; path: string } | { kind: "dir"; path: string };

export interface FileMenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

/**
 * The Source file tree's context menu (right-click, the ⋯ button, or the
 * keyboard's context-menu key): a small fixed-position list of actions.
 * Arrow keys move between items, Escape or a click outside closes it.
 */
export function FileMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: FileMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-40 min-w-[150px] rounded-lg border border-rule bg-ink-2 py-1 font-sans text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-ink-3 focus:bg-ink-3 focus:outline-none ${
            item.danger ? "text-pencil" : "text-paper-dim hover:text-paper"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * An inline path field in the file tree (new file, rename). Enter submits;
 * the handler resolves an error message to keep the field open, or null.
 * Escape cancels. On rename the file name before its extension is selected.
 */
export function PathField({
  label,
  initial,
  selectName = false,
  hint,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  selectName?: boolean;
  hint?: string;
  onSubmit: (value: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectName) {
      const slash = initial.lastIndexOf("/") + 1;
      const dot = initial.lastIndexOf(".");
      el.setSelectionRange(slash, dot > slash ? dot : initial.length);
    } else {
      el.setSelectionRange(initial.length, initial.length);
    }
  }, [initial, selectName]);

  async function submit() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(v);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <div className="px-2 py-1">
      <input
        ref={ref}
        value={value}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy && value.trim() === initial.trim()) onCancel();
        }}
        className="w-full rounded border border-leaf/60 bg-ink px-1.5 py-0.5 font-mono text-[11.5px] text-paper outline-none focus:ring-1 focus:ring-leaf disabled:opacity-60"
      />
      {error ? (
        <p role="alert" className="mt-0.5 text-[10.5px] leading-snug text-pencil">
          {error}
        </p>
      ) : (
        hint && <p className="mt-0.5 text-[10px] leading-snug text-graphite">{hint}</p>
      )}
    </div>
  );
}
