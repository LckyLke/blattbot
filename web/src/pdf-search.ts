/** Normalized PDF search with an exact map back to original text-layer offsets. */
export function mappedPdfText(raw: string, caseSensitive = false) {
  let text = "";
  const starts: number[] = [],
    ends: number[] = [];
  for (let i = 0; i < raw.length; ) {
    const start = i;
    const cp = String.fromCodePoint(raw.codePointAt(i)!);
    if (cp === "-" && i > 0 && /\p{L}/u.test(raw[i - 1])) {
      const split = /^-\s+(?=\p{Ll})/u.exec(raw.slice(i));
      if (split) {
        i += split[0].length;
        continue;
      }
    }
    i += cp.length;
    if (cp === "\u00ad") continue;
    let normalized = cp.normalize("NFKC");
    if (!caseSensitive) normalized = normalized.toLowerCase();
    for (const char of normalized) {
      if (/\s/u.test(char)) {
        if (text.endsWith(" ")) {
          ends[ends.length - 1] = i;
          continue;
        }
        text += " ";
        starts.push(start);
        ends.push(i);
      } else {
        text += char;
        for (let unit = 0; unit < char.length; unit++) {
          starts.push(start);
          ends.push(i);
        }
      }
    }
  }
  return { text, starts, ends };
}
export function findPdfMatches(
  raw: string,
  query: string,
  options: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    limit?: number;
  } = {},
) {
  const hay = mappedPdfText(raw, options.caseSensitive);
  const needle = mappedPdfText(query, options.caseSensitive).text.trim();
  const hits: { start: number; end: number }[] = [];
  if (!needle) return { hits, truncated: false };
  let cursor = 0;
  while (cursor <= hay.text.length) {
    const at = hay.text.indexOf(needle, cursor);
    if (at < 0) break;
    const end = at + needle.length;
    cursor = Math.max(end, at + 1);
    if (
      options.wholeWord &&
      (/([\p{L}\p{N}_])$/u.test(hay.text.slice(0, at)) ||
        /^[\p{L}\p{N}_]/u.test(hay.text.slice(end)))
    )
      continue;
    if (hits.length >= (options.limit ?? 500)) return { hits, truncated: true };
    hits.push({ start: hay.starts[at], end: hay.ends[end - 1] });
  }
  return { hits, truncated: false };
}
