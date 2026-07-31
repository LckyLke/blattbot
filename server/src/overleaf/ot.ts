/**
 * sharejs text-op computation for in-place Overleaf doc updates.
 * Overleaf's realtime channel applies ops of the form {p, i} (insert at
 * position) and {p, d} (delete at position) against the doc as one string.
 */

/** One sharejs text-op component: delete `d` or insert `i` at position `p`. */
export interface TextOpComponent {
  p: number;
  i?: string;
  d?: string;
}

/**
 * Minimal single-splice diff between two texts: trim the common prefix and
 * suffix, then emit at most a delete followed by an insert at the same
 * position (empty components omitted; [] when the texts are equal).
 * Byte-faithful: texts are compared exactly as given — a trailing-newline
 * difference is just part of the edit, never normalized away.
 */
export function computeTextOp(oldText: string, newText: string): TextOpComponent[] {
  if (oldText === newText) return [];
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = oldText.slice(prefix, oldText.length - suffix);
  const inserted = newText.slice(prefix, newText.length - suffix);
  const op: TextOpComponent[] = [];
  if (removed) op.push({ p: prefix, d: removed });
  if (inserted) op.push({ p: prefix, i: inserted });
  return op;
}
