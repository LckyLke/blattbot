/**
 * The Source editor's save rules, kept pure so they can be tested without a
 * DOM. Every save names the server text it was typed over (`base`); the
 * server refuses the write with 409 when the file no longer holds that text,
 * so a draft can never silently revert an agent edit, a sync or a rejection.
 */

/** Unresolved three-way merge conflicts start with this line. */
export const CONFLICT_MARK = "<<<<<<< yours";

/**
 * The text the server must still hold for this save to go through. A normal
 * save sends the base the draft was typed over. "Save mine" after a conflict
 * sends the disk text the user was shown, so it overwrites exactly that
 * version and nothing newer.
 */
export function saveBase(draftBase: string | undefined, saved: string, overwrite: boolean): string {
  if (overwrite) return saved;
  return draftBase ?? saved;
}

export interface AutosaveState {
  /** The autosave toggle. */
  enabled: boolean;
  /** Current editor text. */
  text: string;
  /** Last text fetched from or saved to the server. */
  saved: string;
  /** The "changed on disk" notice is showing. */
  diskChanged: boolean;
  /** The user typed into this document since it was loaded, restored, merged or refused. */
  userTyped: boolean;
  /** An agent turn holds the working tree. */
  busy: boolean;
  /** A save of this file is in flight. */
  saving: boolean;
}

/**
 * Whether the idle timer may write the file. Never while the disk moved under
 * the draft (the user decides with Merge / Save mine / Revert), never for a
 * draft restored from storage that nobody has touched yet, and never with
 * unresolved conflict markers in the text.
 */
export function shouldAutosave(s: AutosaveState): boolean {
  return (
    s.enabled &&
    s.userTyped &&
    !s.diskChanged &&
    !s.busy &&
    !s.saving &&
    s.text !== s.saved &&
    !s.text.includes(CONFLICT_MARK)
  );
}

export type SaveOutcome =
  | { kind: "saved"; diff: string }
  /** The file changed on disk; `disk` is its current text. */
  | { kind: "conflict"; disk: string }
  | { kind: "error"; message: string };

export interface SaveIo {
  /** PUT the file with this base; rejects with an error carrying `status` on failure. */
  save(base: string): Promise<{ diff: string }>;
  /** The file's current text on the server. */
  fetchDisk(): Promise<string>;
}

/**
 * Save with a base check. A 409 is only a content conflict when the file
 * really differs from the base now (the same status also means "agent turn
 * in progress"), so the disk text is fetched to tell the two apart.
 */
export async function saveWithBase(io: SaveIo, base: string): Promise<SaveOutcome> {
  try {
    const res = await io.save(base);
    return { kind: "saved", diff: res.diff };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { status?: number } | null)?.status !== 409) return { kind: "error", message };
    let disk: string;
    try {
      disk = await io.fetchDisk();
    } catch (fetchErr) {
      const why = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return { kind: "error", message: `Not saved: ${message} (the current file could not be read: ${why})` };
    }
    if (disk === base) return { kind: "error", message };
    return { kind: "conflict", disk };
  }
}

/** What the editor shows after a refused save. */
export const CONFLICT_MESSAGE =
  "Not saved: this file changed on disk while you were editing. Your draft is kept — Merge, Save mine or Revert.";
