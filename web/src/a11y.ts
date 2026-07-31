/**
 * Keyboard support for the role="tablist" strips (the pane tab strips in App,
 * the Proof text/rendered toggle, the PDF build-source toggle).
 *
 * Deliberately free of DOM lib types: the server test suite imports this
 * module (server tsconfig has no "DOM" lib), so elements are typed as the
 * minimal structural subset the handler touches — real DOM elements and
 * React's synthetic events satisfy it without casts.
 */

/** Structural subset of an element — exactly what tabStripKeyDown needs. */
export interface TabStripEl {
  closest(selector: string): TabStripEl | null;
  querySelectorAll(selector: string): Iterable<TabStripEl>;
  hasAttribute(name: string): boolean;
  focus?(): void;
  click?(): void;
}

/** The target tab index for a tablist key press, or null when unhandled. */
export function nextTabIndex(key: string, idx: number, count: number): number | null {
  if (count <= 0 || idx < 0) return null;
  switch (key) {
    case "ArrowLeft":
      return (idx - 1 + count) % count;
    case "ArrowRight":
      return (idx + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Roving-focus keyboard handler for a role="tablist" strip — attach to each
 * role="tab" button's onKeyDown. Arrow-Left/Right move focus AND selection
 * (the neighbouring tab is clicked, wrapping at the ends), Home/End jump to
 * the first/last tab; disabled tabs are skipped. Clicks stay untouched.
 */
export function tabStripKeyDown(e: {
  key: string;
  currentTarget: TabStripEl;
  preventDefault(): void;
}): void {
  const strip = e.currentTarget.closest('[role="tablist"]');
  if (!strip) return;
  const tabs = [...strip.querySelectorAll('[role="tab"]')].filter(
    (t) => !t.hasAttribute("disabled"),
  );
  const next = nextTabIndex(e.key, tabs.indexOf(e.currentTarget), tabs.length);
  if (next === null) return;
  e.preventDefault();
  tabs[next].focus?.();
  tabs[next].click?.();
}
