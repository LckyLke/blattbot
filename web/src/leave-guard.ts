/**
 * When leaving or closing must ask first, and what the question says.
 *
 * Pending (unapproved) changes are files on disk: a reload or a closed tab
 * cannot lose them, so they never arm the browser's tab-close prompt. Source
 * drafts persist to browser storage (drafts.ts) and survive a reload too —
 * only drafts storage refused, a save still in flight, or a running agent
 * turn are reasons for that prompt.
 */

export interface UnloadState {
  /** An agent turn runs in the open project. */
  busy: boolean;
  /** Drafts a reload would lose (see unpersistedDraftCount). */
  unpersistedDrafts: number;
  /** File saves still in flight. */
  savesInFlight: number;
}

export function shouldWarnOnUnload(s: UnloadState): boolean {
  return s.busy || s.unpersistedDrafts > 0 || s.savesInFlight > 0;
}

/**
 * The leave dialog's sentence about unsaved editor drafts in a project.
 * `unpersisted` of the `drafts` could not be stored in this browser.
 */
export function draftLeaveNotice(drafts: number, unpersisted: number, name: string): string {
  const files = drafts === 1 ? "1 file" : `${drafts} files`;
  let text =
    `The editors hold unsaved edits in ${files} of “${name}” — they stay in this browser, ` +
    `also across a reload, until you save or revert them.`;
  if (unpersisted > 0) {
    const which = unpersisted >= drafts ? (drafts === 1 ? "That draft is" : "These drafts are") : `${unpersisted} of them ${unpersisted === 1 ? "is" : "are"}`;
    text += ` ${which} too large for browser storage (or storage is off), though: a reload would lose ${unpersisted === 1 ? "it" : "them"}.`;
  }
  return text;
}
