/** Minimal BibTeX parsing — enough for keys, dedupe, and field extraction. */

export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
  raw: string;
}

/** Parse a .bib file into entries using balanced-brace scanning. */
export function parseBib(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([a-zA-Z]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "preamble") continue;
    const bodyStart = re.lastIndex;
    let depth = 1;
    let i = bodyStart;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const raw = text.slice(m.index, i);
    const body = text.slice(bodyStart, i - 1);
    const commaIdx = body.indexOf(",");
    const key = (commaIdx === -1 ? body : body.slice(0, commaIdx)).trim();
    const fieldsSrc = commaIdx === -1 ? "" : body.slice(commaIdx + 1);
    entries.push({ type, key, fields: parseFields(fieldsSrc), raw });
    re.lastIndex = i;
  }
  return entries;
}

/**
 * Locate an entry's exact source span in .bib file content by key.
 * `start` is the index of the `@`, `end` the index just past the closing
 * brace — `content.slice(start, end)` is the entry's full source text.
 * Skips `@string`/`@comment`/`@preamble` blocks (their balanced bodies are
 * consumed, never matched), and the brace balancing is quote-aware at the
 * field level so quoted values containing braces cannot derail the scan.
 */
export function findEntrySpan(content: string, key: string): { start: number; end: number } | null {
  const re = /@([a-zA-Z]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const type = m[1].toLowerCase();
    const bodyStart = re.lastIndex;
    let depth = 1;
    let i = bodyStart;
    let inQuote = false;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (inQuote) {
        if (ch === '"') inQuote = false;
      } else if (ch === '"' && depth === 1) {
        inQuote = true; // a quoted field value — braces inside are literal
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
      i++;
    }
    if (type !== "string" && type !== "comment" && type !== "preamble") {
      const body = content.slice(bodyStart, i - 1);
      const commaIdx = body.indexOf(",");
      const entryKey = (commaIdx === -1 ? body : body.slice(0, commaIdx)).trim();
      if (entryKey === key) return { start: m.index, end: i };
    }
    re.lastIndex = i;
  }
  return null;
}

function parseFields(src: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].toLowerCase();
    let i = re.lastIndex;
    let value = "";
    const ch = src[i];
    if (ch === "{") {
      let depth = 1;
      i++;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      value = src.slice(start, i - 1);
    } else if (ch === '"') {
      i++;
      const start = i;
      while (i < src.length && src[i] !== '"') i++;
      value = src.slice(start, i);
      i++;
    } else {
      const start = i;
      while (i < src.length && !/[,}]/.test(src[i])) i++;
      value = src.slice(start, i).trim();
    }
    fields[name] = cleanValue(value);
    re.lastIndex = i;
  }
  return fields;
}

function cleanValue(v: string): string {
  return v.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function deaccent(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const STOPWORDS = new Set([
  "a", "an", "the", "on", "of", "for", "and", "or", "in", "at", "to", "with",
  "from", "by", "is", "are", "its", "toward", "towards", "via",
]);

/**
 * Build a citation key like `lecun2015deep` from author/year/title.
 * Falls back gracefully when pieces are missing.
 */
export function normalizeKey(author: string | undefined, year: string | undefined, title: string | undefined): string {
  // BibTeX author field: "Last, First and Last2, First2" or "First Last and ..."
  let lastName = "unknown";
  if (author) {
    const first = author.split(/\s+and\s+/i)[0].trim();
    lastName = first.includes(",") ? first.split(",")[0].trim() : (first.split(/\s+/).pop() ?? first);
  }
  let titleWord = "";
  if (title) {
    const words = deaccent(title).toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/);
    titleWord = words.find((w) => w.length > 2 && !STOPWORDS.has(w)) ?? words[0] ?? "";
  }
  const cleanLast = deaccent(lastName).toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown";
  return `${cleanLast}${year ?? ""}${titleWord}`;
}

/** Make `key` unique against `existing` by appending a, b, c… */
export function ensureUniqueKey(key: string, existing: Set<string>): string {
  if (!existing.has(key)) return key;
  for (let i = 0; i < 26; i++) {
    const candidate = key + String.fromCharCode(97 + i);
    if (!existing.has(candidate)) return candidate;
  }
  return `${key}${Date.now() % 10000}`;
}

/** Replace the key of a raw BibTeX entry string. */
export function rewriteKey(raw: string, newKey: string): string {
  return raw.replace(/^(@[a-zA-Z]+\s*\{)\s*[^,\s]*/, `$1${newKey}`);
}

export interface DedupeHit {
  key: string;
  reason: "doi" | "title";
}

/** Find an existing entry matching by DOI (preferred) or normalized title. */
export function findDuplicate(entries: BibEntry[], doi?: string, title?: string): DedupeHit | undefined {
  const normDoi = doi?.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (normDoi) {
    for (const e of entries) {
      const eDoi = e.fields.doi?.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
      if (eDoi && eDoi === normDoi) return { key: e.key, reason: "doi" };
    }
  }
  if (title) {
    const norm = deaccent(title).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length > 8) {
      for (const e of entries) {
        const eTitle = e.fields.title ? deaccent(e.fields.title).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
        if (eTitle && eTitle === norm) return { key: e.key, reason: "title" };
      }
    }
  }
  return undefined;
}
