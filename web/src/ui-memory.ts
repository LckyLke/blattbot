/**
 * Small per-project UI choices remembered in browser storage (the Proof
 * view's text/rendered mode). Every access is guarded: storage can be off,
 * full, or missing (private windows, tests), and the UI then simply starts
 * from its defaults.
 */

/** The subset of Storage used here; injectable for tests. */
export interface UiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Imported by the server's vitest project too (node, no DOM lib).
const browser = globalThis as unknown as { window?: unknown; localStorage?: Storage };

let storage: UiStorage | null = (() => {
  try {
    return browser.window && browser.localStorage ? browser.localStorage : null;
  } catch {
    return null;
  }
})();

/** Point the module at a storage (tests) — `null` disables it. */
export function configureUiStorage(s: UiStorage | null): void {
  storage = s;
}

export function readUiPref(key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeUiPref(key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage off or full — the choice lasts for this page only */
  }
}

export type ProofMode = "text" | "rendered";

const proofModeKey = (projectId: string) => `blattbot.proofMode:${projectId}`;

export function loadProofMode(projectId: string): ProofMode {
  return readUiPref(proofModeKey(projectId)) === "rendered" ? "rendered" : "text";
}

export function saveProofMode(projectId: string, mode: ProofMode): void {
  writeUiPref(proofModeKey(projectId), mode);
}
