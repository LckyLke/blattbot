/**
 * Unsaved Source-editor drafts, kept outside the component tree.
 *
 * The Source panel is unmounted whenever its pane swaps sides (the two panes
 * always show different views, so picking the other pane's view swaps them)
 * and whenever the project view is left and re-entered. Component state dies
 * with the instance; text the user typed must not. This module is the
 * tab-scoped memory of what was typed, over which server content, and which
 * file was open per project — plus the one pure decision the editor has to
 * make when a fresh copy of the open file arrives while it holds text.
 *
 * Invariant the panel maintains: a file has a draft here exactly while its
 * editor text differs from the last content fetched from or saved to the
 * server. That makes `countDrafts` the single source of truth for "unsaved
 * edits exist" (leave dialogs, the tab-close guard).
 *
 * Drafts also persist to browser storage (debounced), so a reload or a
 * crashed tab does not lose them either: on load the store hydrates from
 * storage, and the panel restores a stored draft the next time that file
 * opens — with the "changed on disk" notice if the file moved meanwhile.
 * `base` is kept from the moment the draft began (never re-based while the
 * draft lives), which is what makes a three-way merge possible later.
 */

export interface Draft {
  /** The editor text as last typed. */
  content: string;
  /** The server content the text was typed over (last fetched or saved). */
  base: string;
}

const drafts = new Map<string, Draft>();
const openFiles = new Map<string, string>();
const listeners = new Set<() => void>();

function key(projectId: string, path: string): string {
  return `${projectId}\n${path}`;
}

function notify(): void {
  for (const l of listeners) l();
}

// ---- Persistence -----------------------------------------------------------

/** The subset of Storage the store needs; injectable for tests. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** All keys — `Storage` has length/key(i); a Map-backed fake lists directly. */
  keys(): string[];
}

const STORAGE_PREFIX = "blattbot.draft:";
/** Drafts above this size are kept in memory only (storage quotas are small). */
export const MAX_PERSISTED_CHARS = 1_500_000;
export const PERSIST_DEBOUNCE_MS = 400;

let storage: DraftStorage | null = null;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

// The module is also imported by the server's vitest project (node, no DOM
// lib): every browser global goes through `globalThis` untyped.
type MaybeBrowser = {
  window?: unknown;
  localStorage?: Storage;
  document?: { visibilityState?: string; addEventListener(type: string, fn: () => void): void };
};
const browser = globalThis as unknown as MaybeBrowser;

function browserStorage(): DraftStorage | null {
  try {
    if (!browser.window) return null; // node: skip (its experimental localStorage warns)
    const ls = browser.localStorage;
    if (!ls) return null;
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k) out.push(k);
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

function storageKey(k: string): string {
  return STORAGE_PREFIX + k;
}

/** Point the store at a storage (tests) — `null` disables persistence. */
export function configureDraftStorage(s: DraftStorage | null): void {
  storage = s;
}

/** Load every persisted draft into memory (called once at module load). */
export function hydrateDrafts(): number {
  if (!storage) return 0;
  let n = 0;
  try {
    for (const sk of storage.keys()) {
      if (!sk.startsWith(STORAGE_PREFIX)) continue;
      const raw = storage.getItem(sk);
      if (!raw) continue;
      try {
        const d = JSON.parse(raw) as Partial<Draft>;
        if (typeof d.content === "string" && typeof d.base === "string" && d.content !== d.base) {
          drafts.set(sk.slice(STORAGE_PREFIX.length), { content: d.content, base: d.base });
          n++;
        } else {
          storage.removeItem(sk);
        }
      } catch {
        storage.removeItem(sk);
      }
    }
  } catch {
    /* storage unavailable — memory only */
  }
  if (n > 0) notify();
  return n;
}

function schedulePersist(k: string): void {
  if (!storage) return;
  const prev = pendingWrites.get(k);
  if (prev) clearTimeout(prev);
  pendingWrites.set(
    k,
    setTimeout(() => {
      pendingWrites.delete(k);
      persistNow(k);
    }, PERSIST_DEBOUNCE_MS),
  );
}

function persistNow(k: string): void {
  if (!storage) return;
  const d = drafts.get(k);
  try {
    if (!d) storage.removeItem(storageKey(k));
    else if (d.content.length + d.base.length <= MAX_PERSISTED_CHARS) {
      storage.setItem(storageKey(k), JSON.stringify(d));
    } else storage.removeItem(storageKey(k));
  } catch {
    /* quota or disabled storage — memory copy still holds */
  }
}

/** Write every pending draft immediately (tests; page hide). */
export function flushDraftPersistence(): void {
  for (const [k, t] of pendingWrites) {
    clearTimeout(t);
    pendingWrites.delete(k);
    persistNow(k);
  }
}

export function stashDraft(projectId: string, path: string, draft: Draft): void {
  const k = key(projectId, path);
  const prev = drafts.get(k);
  drafts.set(k, draft);
  schedulePersist(k);
  // Only a presence change is observable to subscribers (counts).
  if (!prev) notify();
}

export function dropDraft(projectId: string, path: string): void {
  const k = key(projectId, path);
  const t = pendingWrites.get(k);
  if (t) {
    clearTimeout(t);
    pendingWrites.delete(k);
  }
  if (drafts.delete(k)) {
    persistNow(k);
    notify();
  }
}

export function readDraft(projectId: string, path: string): Draft | undefined {
  return drafts.get(key(projectId, path));
}

export function hasDraft(projectId: string, path: string): boolean {
  return drafts.has(key(projectId, path));
}

/** Number of files with a draft — in one project, or across all of them. */
export function countDrafts(projectId?: string): number {
  if (projectId === undefined) return drafts.size;
  let n = 0;
  const prefix = `${projectId}\n`;
  for (const k of drafts.keys()) if (k.startsWith(prefix)) n++;
  return n;
}

/** Paths with a draft in the project. */
export function draftPaths(projectId: string): string[] {
  const prefix = `${projectId}\n`;
  const out: string[] = [];
  for (const k of drafts.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
  return out;
}

/** Subscribe to presence changes (for useSyncExternalStore). */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function rememberOpenFile(projectId: string, path: string | null): void {
  if (path) openFiles.set(projectId, path);
  else openFiles.delete(projectId);
}

export function lastOpenFile(projectId: string): string | undefined {
  return openFiles.get(projectId);
}

/** Test hook: forget everything (memory and storage). */
export function resetDrafts(): void {
  for (const t of pendingWrites.values()) clearTimeout(t);
  pendingWrites.clear();
  const keys = [...drafts.keys()];
  drafts.clear();
  openFiles.clear();
  for (const k of keys) persistNow(k);
  notify();
}

// Module init: browser storage when there is one, and hydrate from it.
configureDraftStorage(browserStorage());
hydrateDrafts();
if (browser.document?.addEventListener) {
  // A hidden tab may be discarded — write the debounced drafts out first.
  browser.document.addEventListener("visibilitychange", () => {
    if (browser.document?.visibilityState === "hidden") flushDraftPersistence();
  });
}

export type Reconcile =
  /** The editor was clean: show the fetched content (a no-op when identical). */
  | { action: "replace" }
  /** The editor holds a draft: keep it. `dirty` says whether it still differs
   *  from the fetched content; `changedOnDisk` whether the server copy moved
   *  under the draft (agent edit, sync, rejection) since the draft began. */
  | { action: "keep"; dirty: boolean; changedOnDisk: boolean };

/**
 * What to do with a freshly fetched copy of the open file.
 *
 * `current` is the editor text, `prevBase` the server content the editor was
 * last synced to (fetched or saved), `fetched` the new server content. The
 * editor text is the only witness of a draft — never a React "dirty" flag,
 * which lags a keystroke, and which a finishing save used to reset even
 * though the user had kept typing during the round-trip (the fetched copy
 * then replaced those keystrokes).
 */
export function reconcileFetched(current: string, prevBase: string, fetched: string): Reconcile {
  if (current === prevBase) return { action: "replace" };
  return { action: "keep", dirty: current !== fetched, changedOnDisk: fetched !== prevBase };
}
