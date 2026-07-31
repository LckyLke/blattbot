/**
 * The one markdown renderer for chat text: GFM (tables, strikethrough,
 * autolinks) plus TeX math — inline $…$ / \(…\) and display $$…$$ / \[…\] —
 * rendered with KaTeX. Raw HTML stays escaped (no rehype-raw): react-markdown's
 * default escaping is the XSS boundary, and KaTeX runs with trust:false.
 * KaTeX's CSS is imported here so Vite bundles the fonts locally and the app
 * stays fully offline-capable.
 *
 * Network posture: chat content is untrusted (prompt injection can reach the
 * model through project files and fetched pages), so rendering a bubble must
 * NEVER issue a network request. Images are replaced by an inert chip naming
 * the alt text and host (no <img>, no fetch — see the `img` override), and
 * URLs are restricted to http(s)/mailto/relative (`safeUrl`); javascript:,
 * data:, file: and friends lose their href entirely. Links stay click-gated
 * and open with rel="noreferrer noopener".
 *
 * Project awareness (optional, prop-driven): mentions like `main.tex:42` or
 * `sections/intro.tex` become links into the Source panel when the path exists
 * in the project, and assistant blockquotes grow "find in source" /
 * "find in PDF" actions that reveal the quoted passage.
 *
 * The component is memoized: settled chat bubbles keep a stable `text`, so
 * during streaming only the actively-growing bubble re-parses and re-renders.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

const KATEX_OPTIONS = {
  // Bad TeX degrades to visibly-marked source text instead of crashing.
  throwOnError: false,
  errorColor: "var(--color-pencil)",
  // Never honor \htmlClass & friends from model output.
  trust: false,
  // HTML for layout + hidden MathML for screen readers.
  output: "htmlAndMathml" as const,
};

/** Code segments the math pre-transform must not touch: fences, then inline spans. */
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[^\n]*?``|`[^`\n]*`)/;

/**
 * \[…\] / \(…\) bodies must stay within one paragraph (no blank line) and must
 * not contain another opener of their own kind — so an unpaired lookalike
 * (`\\[4pt]` in prose, a stray `\(` sentences before an unrelated `\)`) never
 * swallows the text up to some later closer; it just stays untouched.
 */
const DISPLAY_BRACKET = /\\\[((?:(?!\\\[)(?:[^\n]|\n(?!\n)))*?)\\\]/g;
const INLINE_PAREN = /\\\(((?:(?!\\\()(?:[^\n]|\n(?!\n)))*?)\\\)/g;

/**
 * The delimiter rewrites for one prose segment (no code in it):
 * \[…\]/\(…\) → $$…$$/$…$, then a standalone single-line $$…$$ expands to the
 * fenced multi-line form remark-math parses as a display block. The line's
 * indentation is preserved on all three fence lines so a display equation on a
 * list item's continuation line stays INSIDE the item instead of splitting the
 * list. Single-$ semantics are remark-math's own: a lone "$5" has no closing
 * dollar and stays plain text.
 */
function mathReplace(prose: string): string {
  return prose
    .replace(DISPLAY_BRACKET, (_m, body: string) => `$$${body}$$`)
    .replace(INLINE_PAREN, (_m, body: string) => `$${body}$`)
    .replace(
      /^([ \t]*)\$\$([^$\n]+?)\$\$[ \t]*$/gm,
      (_m, indent: string, body: string) => `${indent}$$\n${indent}${body}\n${indent}$$`,
    );
}

/**
 * Split a prose chunk into segments, isolating CommonMark indented code
 * blocks (runs of ≥4-space/tab lines opened after a blank line or at the
 * chunk's line-start beginning) so the math rewrites never touch them.
 * Approximation: a lazy paragraph continuation that happens to be indented is
 * treated as code too — protection errs on the side of leaving bytes alone.
 */
function splitIndentedCode(part: string, atLineStart: boolean): { text: string; code: boolean }[] {
  if (!/(?:^|\n)(?: {4}|\t)/.test(part)) return [{ text: part, code: false }];
  const lines = part.split("\n");
  const segs: { text: string; code: boolean }[] = [];
  const push = (text: string, code: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.code === code) last.text += text;
    else segs.push({ text, code });
  };
  let prevBlank = atLineStart;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withNl = i < lines.length - 1 ? `${line}\n` : line;
    const blank = /^[ \t]*$/.test(line);
    const indented = !blank && /^(?: {4}|\t)/.test(line) && (i > 0 || atLineStart);
    if (indented && (prevBlank || inCode)) {
      inCode = true;
      push(withNl, true);
    } else {
      inCode = false;
      push(withNl, false);
    }
    prevBlank = blank;
  }
  return segs;
}

/**
 * Streaming guard: a line-leading `$$` opener whose closing `$$` has not
 * arrived yet would render as an EMPTY display-math box (remark-math treats
 * the rest of the line as fence meta). Escape that opener (`\$\$`) so the raw
 * text stays visible until the closer streams in — at which point the text no
 * longer matches and the block renders normally. Code segments are skipped.
 */
function suppressOpenDisplay(src: string): string {
  if (!src.includes("$$")) return src;
  const parts = src.split(CODE_SEGMENT);
  const lineArrays = parts.map((p, i) => (i % 2 === 1 ? null : p.split("\n")));
  let open: { part: number; line: number } | null = null;
  let atLineStart = true;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === undefined || parts[i] === "") continue;
    const lines = lineArrays[i];
    if (!lines) {
      // A code segment has no math semantics; it only moves the line cursor.
      atLineStart = parts[i].endsWith("\n");
      continue;
    }
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (open) {
        if (line.includes("$$")) open = null; // the closer arrived
      } else if (li > 0 || atLineStart) {
        const m = /^[ \t]*\$\$(.*)$/.exec(line);
        if (m && !m[1].includes("$$")) open = { part: i, line: li };
      }
    }
    atLineStart = parts[i].endsWith("\n");
  }
  if (!open) return src;
  const lines = lineArrays[open.part]!;
  lines[open.line] = lines[open.line].replace("$$", "\\$\\$");
  parts[open.part] = lines.join("\n");
  return parts.join("");
}

/**
 * Rewrite LaTeX-style \(…\) / \[…\] delimiters to remark-math's $…$ / $$…$$,
 * skipping fenced code blocks, inline code spans, and indented code blocks so
 * a literal \( inside code stays raw; then suppress a still-open display
 * fence (see suppressOpenDisplay).
 */
export function normalizeMathDelimiters(src: string): string {
  if (!src.includes("\\(") && !src.includes("\\[") && !src.includes("$$")) return src;
  const parts = src.split(CODE_SEGMENT);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === undefined) continue;
    if (i % 2 === 1) {
      out += parts[i]; // a code segment — leave byte-identical
      continue;
    }
    const atLineStart = out.length === 0 || out.endsWith("\n");
    for (const seg of splitIndentedCode(parts[i], atLineStart)) {
      out += seg.code ? seg.text : mathReplace(seg.text);
    }
  }
  return suppressOpenDisplay(out);
}

/**
 * URL policy for everything react-markdown renders: http(s), mailto, and
 * relative URLs survive; every other scheme (javascript:, data:, vbscript:,
 * file:, irc:, xmpp:, …) collapses to "" and the `a` renderer then drops the
 * href entirely. Exported so tests can pin the guarantee.
 */
export function safeUrl(url: string): string {
  const out = defaultUrlTransform(url);
  // defaultUrlTransform already kills javascript:/data:; it additionally
  // admits irc/ircs/xmpp, which have no place in chat prose.
  return /^(ircs?|xmpp):/i.test(out) ? "" : out;
}

// ---- File[:line] linkification ----------------------------------------------

/** Minimal structural hast typing — enough for the small tree walk below. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/** A path-looking token (`sections/intro.tex`), optionally with `:line`. */
const FILE_MENTION = /((?:[\w.+-]+\/)*[\w+-]+(?:\.[\w+-]+)+)(?::(\d+))?(?!\w)/g;

/** Split a text value around project-file mentions; null = nothing to link. */
function linkifyValue(value: string, files: ReadonlySet<string>): HastNode[] | null {
  FILE_MENTION.lastIndex = 0;
  let out: HastNode[] | null = null;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_MENTION.exec(value)) !== null) {
    const [whole, path, line] = m;
    if (!files.has(path)) continue; // not a real project file — stays plain text
    out ??= [];
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "a",
      properties: { dataFileLink: path, ...(line ? { dataFileLine: line } : {}) },
      children: [{ type: "text", value: whole }],
    });
    last = m.index + whole.length;
  }
  if (!out) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/**
 * Rehype plugin: turn mentions of existing project files (`main.tex:42`,
 * `refs.bib`) into source links — inside inline code spans too, where agents
 * habitually put them. Block code (<pre>), existing links, and KaTeX output
 * are left alone.
 */
function rehypeFileLinks(options: { files: ReadonlySet<string> }) {
  const walk = (node: HastNode): void => {
    if (node.type === "element") {
      if (node.tagName === "a" || node.tagName === "pre") return;
      const cls = node.properties?.className;
      if (Array.isArray(cls) && cls.some((c) => typeof c === "string" && c.includes("katex"))) {
        return;
      }
    }
    const children = node.children;
    if (!children) return;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.type === "text" && typeof child.value === "string") {
        const replaced = linkifyValue(child.value, options.files);
        if (replaced) children.splice(i, 1, ...replaced);
      } else {
        walk(child);
      }
    }
  };
  return (tree: HastNode) => walk(tree);
}

/** All text under a hast node, whitespace-collapsed (for quote lookups). */
function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join(" ");
}

/** Hostname of an http(s) URL, for the blocked-image chip; null otherwise. */
function imageHost(src: unknown): string | null {
  if (typeof src !== "string" || !src) return null;
  try {
    const u = new URL(src);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

// ---- Blockquote actions ------------------------------------------------------

const QUOTE_MAX = 1000;
/** How long the "couldn't find that passage" state stays (mirrors the PDF toast). */
const MISS_MS = 2400;

/**
 * An assistant blockquote with jump actions: "find in source" POSTs the quote
 * to the locate endpoint via `findInSource` (which reveals the hit and
 * resolves false on a miss — shown as a muted inline state), and
 * "find in PDF" (only offered while a PDF pane is visible) highlights the
 * passage in the rendered PDF's text layer.
 */
function QuoteBlock({
  node,
  children,
  findInSource,
  findInPdf,
}: {
  node?: HastNode;
  children?: ReactNode;
  findInSource: (text: string) => Promise<boolean>;
  findInPdf?: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "missing">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const quote = useMemo(
    () => (node ? hastText(node).replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX) : ""),
    [node],
  );

  async function locate() {
    if (state === "busy" || !quote) return;
    setState("busy");
    const found = await findInSource(quote);
    if (found) {
      setState("idle");
      return;
    }
    setState("missing");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), MISS_MS);
  }

  return (
    <blockquote>
      {children}
      {quote && (
        <span className="md-quote-actions">
          <button
            type="button"
            onClick={() => void locate()}
            title="Reveal this passage in the Source panel"
          >
            {state === "busy" ? "finding…" : "find in source"}
          </button>
          {findInPdf && (
            <button
              type="button"
              onClick={() => findInPdf(quote)}
              title="Highlight this passage in the PDF pane"
            >
              find in PDF
            </button>
          )}
          {state === "missing" && (
            <span role="status" className="md-quote-miss">
              couldn&rsquo;t find that passage
            </span>
          )}
        </span>
      )}
    </blockquote>
  );
}

interface Props {
  text: string;
  /** Extra classes on the wrapper (the `md-body` base class is always applied). */
  className?: string;
  /** Project file list — enables `file[:line]` links into the Source panel. */
  files?: readonly string[];
  /** Reveal a project file in the Source panel (1-based line; 1 when unspecified). */
  onOpenFile?: (file: string, line: number) => void;
  /** Locate a blockquote's text in the .tex sources; resolves false on a miss. */
  onLocateQuote?: (text: string) => Promise<boolean>;
  /** Highlight a blockquote's text in the rendered PDF — pass only while a PDF pane is visible. */
  onFindInPdf?: (text: string) => void;
}

const Markdown = memo(function Markdown({
  text,
  className,
  files,
  onOpenFile,
  onLocateQuote,
  onFindInPdf,
}: Props) {
  const source = useMemo(() => normalizeMathDelimiters(text), [text]);
  const fileSet = useMemo(() => new Set(files ?? []), [files]);
  const rehypePlugins = useMemo(() => {
    const list: import("react-markdown").Options["rehypePlugins"] = [[rehypeKatex, KATEX_OPTIONS]];
    if (fileSet.size > 0 && onOpenFile) list!.push([rehypeFileLinks, { files: fileSet }]);
    return list;
  }, [fileSet, onOpenFile]);

  return (
    <div className={className ? `md-body ${className}` : "md-body"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        urlTransform={safeUrl}
        components={{
          // GFM tables scroll inside their own wrapper — the bubble never widens.
          table: ({ node: _node, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
          // Images must never fetch: an inert chip replaces the <img> element,
          // so untrusted content cannot exfiltrate through image URLs.
          img: ({ node: _node, src, alt, title }) => {
            const host = imageHost(src);
            const srcText = typeof src === "string" ? src : "";
            return (
              <span className="md-img-chip" title={title || srcText || undefined}>
                image{alt ? ` · ${alt}` : ""}{host ? ` · ${host}` : ""}
              </span>
            );
          },
          // Links: file links jump into the Source panel; web links stay
          // click-gated in a new tab; a neutralized scheme keeps no href.
          a: ({ node: _node, href, children, ...rest }) => {
            const extra = rest as Record<string, unknown>;
            const file = extra["data-file-link"];
            if (typeof file === "string" && onOpenFile) {
              const line = Number(extra["data-file-line"]) || 1;
              return (
                <a
                  {...rest}
                  href="#"
                  className="md-file-link"
                  title={`Open ${file} in the Source panel`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFile(file, line);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (!href) return <a {...rest}>{children}</a>;
            return (
              <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          ...(onLocateQuote
            ? {
                blockquote: ({ node, children }: { node?: unknown; children?: ReactNode }) => (
                  <QuoteBlock
                    node={node as HastNode | undefined}
                    findInSource={onLocateQuote}
                    findInPdf={onFindInPdf}
                  >
                    {children}
                  </QuoteBlock>
                ),
              }
            : {}),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
