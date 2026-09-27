/** An unfinished @ mention at the caret, never an email or completed token. */
export function mentionQuery(text: string, caret: number) {
  const match = /(?:^|\s)@([^@\n{}]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1];
  return { start: caret - query.length - 1, end: caret, query };
}
export function insertMention(text: string, range: { start: number; end: number }, token: string) {
  return { text: text.slice(0, range.start) + token + " " + text.slice(range.end), caret: range.start + token.length + 1 };
}
