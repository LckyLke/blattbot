/**
 * One working-tree operation per project at a time. Approve, sync, rejects,
 * manual saves, reference edits and the git steps of a turn pipeline all run
 * through here, so an approve's `git add --all` can never pick up edits that
 * started mid-approve, a sync can never move HEAD under an approve that is
 * still pushing, and two git commands never race on `.git/index.lock`.
 *
 * Waiters run in arrival order. The lock is NOT re-entrant: code holding it
 * must not call another locked function for the same project.
 */
const tails = new Map<string, Promise<void>>();

export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  tails.set(projectId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(projectId) === tail) tails.delete(projectId);
  }
}
