/** Keep the Source and Proof editors of a file in step within this tab. */
export type EditorUpdate = {
  projectId: string;
  path: string;
  origin: symbol;
} & (
  | { kind: "document"; content: string; saved: string }
  | { kind: "saving"; saving: boolean }
);

const listeners = new Set<(update: EditorUpdate) => void>();
const saveListeners = new Set<() => void>();
const saves = new Set<string>();
const key = (projectId: string, path: string) => `${projectId}\n${path}`;

export function subscribeEditors(listener: (update: EditorUpdate) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyEditors(update: EditorUpdate): void {
  for (const listener of listeners) listener(update);
}

export function isFileSaving(projectId: string, path: string): boolean {
  return saves.has(key(projectId, path));
}

export function countFileSaves(projectId: string): number {
  let count = 0;
  for (const k of saves) if (k.startsWith(projectId + "\n")) count++;
  return count;
}

export function subscribeFileSaves(listener: () => void): () => void {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
}

/** A save belongs to the file, including when both panes have autosave on. */
export function startFileSave(projectId: string, path: string, origin: symbol): (() => void) | null {
  const k = key(projectId, path);
  if (saves.has(k)) return null;
  saves.add(k);
  for (const listener of saveListeners) listener();
  notifyEditors({ projectId, path, origin, kind: "saving", saving: true });
  return () => {
    saves.delete(k);
    for (const listener of saveListeners) listener();
    notifyEditors({ projectId, path, origin, kind: "saving", saving: false });
  };
}
