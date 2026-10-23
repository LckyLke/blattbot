/**
 * App-wide keyboard shortcuts. They are single keys without Ctrl/Cmd/Alt, so
 * they never clash with the browser's shortcuts or the editor's (Mod-S,
 * Mod-G, Mod-F and friends stay where they are), and they only fire while
 * focus is NOT in a text field, the chat composer or a CodeMirror editor —
 * typing is never intercepted. Open dialogs and menus also switch them off.
 */
import { useEffect, useRef } from "react";

export type ShortcutView = "chat" | "proof" | "source" | "pdf" | "history" | "refs" | "research";

export type ShortcutAction =
  | { kind: "help" }
  | { kind: "focusChat" }
  | { kind: "view"; view: ShortcutView }
  | { kind: "nextChange" }
  | { kind: "prevChange" }
  | { kind: "approveAll" };

const VIEW_KEYS: Record<string, ShortcutView> = {
  "1": "chat",
  "2": "proof",
  "3": "source",
  "4": "pdf",
  "5": "history",
  "6": "refs",
  "7": "research",
};

/** The cheat sheet: what each key does, in display order. */
export interface SheetRow {
  keys: string[];
  /** How several keys combine (default "or"). */
  join?: "or" | "+" | "then";
  label: string;
}

export const SHORTCUT_SHEET: SheetRow[] = [
  { keys: ["?"], label: "Show these shortcuts" },
  { keys: ["c"], label: "Focus the chat composer" },
  { keys: ["1"], label: "Show Chat" },
  { keys: ["2"], label: "Show Proof" },
  { keys: ["3"], label: "Show Source" },
  { keys: ["4"], label: "Show PDF" },
  { keys: ["5"], label: "Show History" },
  { keys: ["6"], label: "Show References" },
  { keys: ["7"], label: "Show Research" },
  { keys: ["j", "]"], label: "Next change in Proof" },
  { keys: ["k", "["], label: "Previous change in Proof" },
  { keys: ["Shift", "A"], join: "+", label: "Approve & push all changes (asks first)" },
  { keys: ["Esc", "Tab"], join: "then", label: "Leave the Source editor (Escape, then Tab)" },
];

/** The editor's own keys, listed on the cheat sheet for completeness. */
export const EDITOR_SHEET: SheetRow[] = [
  { keys: ["Ctrl/⌘", "S"], join: "+", label: "Save the open file" },
  { keys: ["Ctrl/⌘", "F"], join: "+", label: "Find in the Source editor or the PDF" },
  { keys: ["Ctrl/⌘", "G"], join: "+", label: "Go to line" },
  { keys: ["Ctrl/⌘", "Enter"], join: "+", label: "Save an inline Proof edit" },
];

/** The subset of a DOM element this module looks at (tests pass plain objects). */
interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

/** Focus is somewhere keys mean text: a field, a select, contenteditable, an editor. */
export function isTypingTarget(target: unknown): boolean {
  const el = target as TargetLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUTS.has((el.type ?? "").toLowerCase());
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" && el.closest(".cm-editor, [contenteditable=''], [contenteditable='true'], [role='textbox']")) return true;
  return false;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: unknown;
}

/** The shortcut a key press means, or null to leave it alone. */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented || e.isComposing) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  if (e.key === "?") return { kind: "help" };
  if (e.shiftKey) return e.key === "A" ? { kind: "approveAll" } : null;
  if (e.key === "c") return { kind: "focusChat" };
  if (e.key === "j" || e.key === "]") return { kind: "nextChange" };
  if (e.key === "k" || e.key === "[") return { kind: "prevChange" };
  const view = VIEW_KEYS[e.key];
  return view ? { kind: "view", view } : null;
}

export interface ShortcutHandlers {
  /** Whether project shortcuts apply (help works everywhere). */
  inProject: boolean;
  help: () => void;
  focusChat: () => void;
  showView: (view: ShortcutView) => void;
  proof: (command: ProofCommand) => void;
}

/** A dialog or menu is open — keys belong to it. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector("[role='dialog'], [role='alertdialog'], [role='menu']"));
}

/** Listen for the shortcuts on the window; handlers may change every render. */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action || overlayOpen()) return;
      const h = ref.current;
      if (action.kind !== "help" && !h.inProject) return;
      e.preventDefault();
      switch (action.kind) {
        case "help":
          h.help();
          break;
        case "focusChat":
          h.focusChat();
          break;
        case "view":
          h.showView(action.view);
          break;
        case "nextChange":
          h.proof("next");
          break;
        case "prevChange":
          h.proof("prev");
          break;
        case "approveAll":
          h.proof("approveAll");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ---- Proof commands ---------------------------------------------------------
// The shortcuts reach the Proof panel through this small bus. A command sent
// before the panel has mounted (its first showing loads it) waits briefly for it.

export type ProofCommand = "next" | "prev" | "approveAll";

const proofListeners = new Set<(command: ProofCommand) => void>();
let pendingCommand: { command: ProofCommand; at: number } | null = null;
const PENDING_MS = 3000;

export function sendProofCommand(command: ProofCommand): void {
  if (proofListeners.size === 0) {
    pendingCommand = { command, at: Date.now() };
    return;
  }
  for (const l of proofListeners) l(command);
}

export function onProofCommand(listener: (command: ProofCommand) => void): () => void {
  proofListeners.add(listener);
  const pending = pendingCommand;
  pendingCommand = null;
  if (pending && Date.now() - pending.at < PENDING_MS) listener(pending.command);
  return () => {
    proofListeners.delete(listener);
  };
}
