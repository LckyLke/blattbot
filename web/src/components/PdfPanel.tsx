import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { tabStripKeyDown } from "../a11y";
import type { CompileInfo } from "../api";

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  projectId: string;
  compile: CompileInfo | null;
  stamp: number;
  /** True while a compile runs (server- or UI-initiated). */
  compiling: boolean;
  /** Bumps after each successful "Verify on Overleaf" build (0 = none yet). */
  remoteStamp: number;
  /** Which build the viewer shows; "remote" only exists after a verify. */
  source: "local" | "remote";
  onSelectSource: (source: "local" | "remote") => void;
  /** Jump to a file/line in the Source view (App wires this to revealInSource). */
  onJumpToSource: (file: string, line: number) => void;
  /** True while the other pane shows the chat — enables the quote chip. */
  chatVisible: boolean;
  /** Push normalized PDF-selection text into the chat composer draft. */
  onQuoteToChat: (text: string) => void;
  /** A chat-blockquote passage to find and highlight; each new nonce runs once. */
  find?: { text: string; nonce: number } | null;
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const QUOTE_MAX = 600;
/** How long the find-in-PDF highlight stays on the matched spans. */
const FIND_FLASH_MS = 2000;

/**
 * Normalize text lifted from the PDF text layer: drop soft hyphens, expand
 * ligatures (ﬁ→fi, …), rejoin line-break hyphenation ("exam- ple" →
 * "example"), and collapse whitespace.
 */
function normalizePdfText(s: string): string {
  return foldGlyphs(s)
    .replace(/([A-Za-z])-\s+(?=[a-z])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Expand typographic ligatures and drop soft hyphens (mirrors locate.ts). */
function foldGlyphs(s: string): string {
  return s
    .replace(/\u00AD/g, "")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl");
}

// ---- Find-in-PDF: word-run matching over the pages' text content ------------
// The client-side sibling of the server's locate.ts: both sides fold into
// comparison words, then the longest run of consecutive shared words wins and
// a hit needs ≥4 words (or ≥60% of a shorter query).

interface PageToken {
  /** Folded, lowercased alphanumerics only. */
  key: string;
  /** Character range in the page's item strings joined with single spaces. */
  start: number;
  end: number;
  /** The raw word ended in "-" — a line-break hyphenation candidate. */
  hyphen: boolean;
}

/** Comparison words of a chat passage (query side — no offsets needed). */
function queryKeys(s: string): string[] {
  return foldGlyphs(s)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9À-ɏ]+/g, ""))
    .filter(Boolean)
    .slice(0, 80);
}

/** Tokenize a page's joined item text, rejoining hyphenated line breaks. */
function pageTokens(joined: string): PageToken[] {
  const raw: PageToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    const folded = foldGlyphs(m[0]);
    const key = folded.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, "");
    if (!key) continue;
    raw.push({
      key,
      start: m.index,
      end: m.index + m[0].length,
      hyphen: /[a-zA-Z0-9À-ɏ]-$/.test(folded),
    });
  }
  const out: PageToken[] = [];
  for (const t of raw) {
    const prev = out[out.length - 1];
    if (prev?.hyphen && /^[a-zÀ-ɏ]/.test(t.key)) {
      prev.key += t.key;
      prev.end = t.end;
      prev.hyphen = t.hyphen;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/** Longest run of consecutive shared words (same DP as locate.ts's bestRun). */
function bestRun(q: string[], src: string[]): { len: number; start: number } {
  let prev = new Int32Array(q.length);
  let cur = new Int32Array(q.length);
  let len = 0;
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    const key = src[i];
    for (let j = 0; j < q.length; j++) {
      cur[j] = key === q[j] ? (j > 0 ? prev[j - 1] : 0) + 1 : 0;
      if (cur[j] > len) {
        len = cur[j];
        start = i - cur[j] + 1;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { len, start };
}

/** Where a find landed: a char range in page `page`'s joined item text. */
interface FindHighlight {
  nonce: number;
  page: number;
  start: number;
  end: number;
}

export default function PdfPanel({
  projectId,
  compile,
  stamp,
  compiling,
  remoteStamp,
  source,
  onSelectSource,
  onJumpToSource,
  chatVisible,
  onQuoteToChat,
  find,
}: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  /** Brief inline notice ("no matching source found") — no alert(). */
  const [toast, setToast] = useState<string | null>(null);
  /** Floating "quote in chat" chip near the end of a PDF text selection. */
  const [chip, setChip] = useState<{ x: number; y: number; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Tick the elapsed-seconds readout while a compile is in flight.
  useEffect(() => {
    if (!compiling) return;
    setElapsed(0);
    const started = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(iv);
  }, [compiling]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const prevProject = useRef(projectId);

  // "remote" shows the last "Verify on Overleaf" build — Overleaf's own
  // compiler output for the project as it currently is on Overleaf.
  const showingRemote = source === "remote" && remoteStamp > 0;
  const pdfUrl = showingRemote
    ? `/api/projects/${projectId}/pdf?source=remote&v=${remoteStamp}`
    : `/api/projects/${projectId}/pdf?v=${stamp}`;
  const hasPdf = showingRemote || Boolean(compile?.hasPdf);

  useEffect(() => {
    if (!hasPdf) return;
    // Recompiles of the same project keep the reading position; switching projects resets it.
    savedScroll.current = prevProject.current === projectId ? (scrollRef.current?.scrollTop ?? 0) : 0;
    prevProject.current = projectId;

    let cancelled = false;
    const task = getDocument({ url: pdfUrl });
    task.promise.then(
      (d) => {
        if (cancelled) {
          void d.loadingTask.destroy();
          return;
        }
        setDoc(d);
        setLoadError(null);
      },
      (err: any) => {
        if (!cancelled) setLoadError(err?.message ?? "failed to load PDF");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pdfUrl, hasPdf, projectId]);

  // Destroy the previous document whenever it is replaced (or on unmount).
  useEffect(() => {
    if (!doc) return;
    return () => {
      void doc.loadingTask.destroy();
    };
  }, [doc]);

  useLayoutEffect(() => {
    if (doc && scrollRef.current) scrollRef.current.scrollTop = savedScroll.current;
  }, [doc]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Find-in-PDF (chat blockquote action): search every page's text content
  // for the passage, then hand the winning char range to that page, which
  // scrolls to and flashes the matching text-layer spans. Runs once per nonce
  // (the mount-time nonce is skipped so remounting a pane never re-runs an
  // old find). A miss uses the same toast as the dblclick locate flow.
  const [findHl, setFindHl] = useState<FindHighlight | null>(null);
  const lastFindNonce = useRef(find?.nonce ?? 0);
  useEffect(() => {
    if (!find || find.nonce === lastFindNonce.current) return;
    lastFindNonce.current = find.nonce;
    const d = doc;
    if (!d) {
      showToast("couldn't find that passage in the PDF");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const q = queryKeys(find.text);
        if (q.length === 0) return;
        const need = Math.min(4, Math.max(1, Math.ceil(q.length * 0.6)));
        let best: { page: number; len: number; start: number; end: number } | null = null;
        for (let p = 1; p <= d.numPages; p++) {
          const content = await (await d.getPage(p)).getTextContent();
          if (cancelled) return;
          const joined = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
          const toks = pageTokens(joined);
          const run = bestRun(q, toks.map((t) => t.key));
          if (run.len >= need && run.len > (best?.len ?? 0)) {
            best = {
              page: p,
              len: run.len,
              start: toks[run.start].start,
              end: toks[run.start + run.len - 1].end,
            };
          }
        }
        if (cancelled) return;
        if (!best) {
          showToast("couldn't find that passage in the PDF");
          return;
        }
        const hit = best;
        setFindHl((prev) => ({
          nonce: (prev?.nonce ?? 0) + 1,
          page: hit.page,
          start: hit.start,
          end: hit.end,
        }));
      } catch {
        if (!cancelled) showToast("couldn't find that passage in the PDF");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [find, doc, showToast]);

  // ---- Search in the PDF -----------------------------------------------
  // The browser's own find only sees pages whose text layer is rendered (they
  // mount lazily), so the panel searches the document's text itself: every
  // page's text content is scanned for the query and each hit is scrolled to
  // and flashed through the same highlight path the passage-find uses.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ page: number; start: number; end: number }[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Per-page joined text, rebuilt when the document changes. */
  const pageTextCache = useRef(new Map<number, string>());
  useEffect(() => {
    pageTextCache.current = new Map();
    setSearchHits([]);
    setSearchIdx(0);
  }, [doc]);

  const pageText = useCallback(
    async (p: number): Promise<string> => {
      const cached = pageTextCache.current.get(p);
      if (cached !== undefined) return cached;
      const content = await (await doc!.getPage(p)).getTextContent();
      const joined = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      pageTextCache.current.set(p, joined);
      return joined;
    },
    [doc],
  );

  // Debounced scan of the whole document for the current query.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!doc || q.length < 2) {
      setSearchHits([]);
      setSearchIdx(0);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const hits: { page: number; start: number; end: number }[] = [];
        // Fold the query the same way the page text is folded, so ligatures
        // and hyphenation do not hide matches.
        const needle = normalizePdfText(q).toLowerCase();
        try {
          for (let p = 1; p <= doc.numPages; p++) {
            const raw = await pageText(p);
            if (cancelled) return;
            const hay = normalizePdfText(raw).toLowerCase();
            // Map normalized offsets back is lossy; search the RAW text too so
            // the highlight range lines up with the page's own item text.
            const rawHay = raw.toLowerCase();
            let from = 0;
            while (hits.length < 500) {
              const at = rawHay.indexOf(q.toLowerCase(), from);
              if (at === -1) break;
              hits.push({ page: p, start: at, end: at + q.length });
              from = at + Math.max(1, q.length);
            }
            // Fall back to the folded text when the raw form has no hit but
            // the folded one does (ligatures, collapsed whitespace).
            if (!rawHay.includes(q.toLowerCase()) && hay.includes(needle)) {
              hits.push({ page: p, start: 0, end: Math.min(raw.length, 1) });
            }
          }
          if (cancelled) return;
          setSearchHits(hits);
          setSearchIdx(0);
          setSearching(false);
          if (hits.length > 0) {
            setFindHl((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, ...hits[0] }));
          }
        } catch {
          if (!cancelled) {
            setSearchHits([]);
            setSearching(false);
          }
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, doc, pageText]);

  const gotoHit = useCallback(
    (delta: number) => {
      if (searchHits.length === 0) return;
      const next = (searchIdx + delta + searchHits.length) % searchHits.length;
      setSearchIdx(next);
      setFindHl((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, ...searchHits[next] }));
    },
    [searchHits, searchIdx],
  );

  // Ctrl/Cmd+F opens the search box while this panel is on screen.
  useEffect(() => {
    if (!hasPdf) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        const wrap = overlayRef.current;
        if (!wrap || !wrap.offsetParent) return; // this pane is hidden
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPdf]);

  /** Double-clicked word + context → the server's best source position. */
  const locate = useCallback(
    async (query: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/locate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: query }),
        });
        if (!res.ok) {
          showToast("no matching source found");
          return;
        }
        const { file, line } = (await res.json()) as { file: string; line: number };
        onJumpToSource(file, line);
      } catch {
        showToast("no matching source found");
      }
    },
    [projectId, onJumpToSource, showToast],
  );

  // A finished selection inside the text layer offers the quote chip —
  // only while the other pane shows the chat to receive it.
  const handleMouseUp = useCallback(() => {
    if (!chatVisible) return;
    // Let the browser settle the selection first.
    setTimeout(() => {
      const wrap = overlayRef.current;
      const sel = window.getSelection();
      if (!wrap || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString();
      if (!text.trim()) return;
      const range = sel.getRangeAt(sel.rangeCount - 1);
      // A selection spanning two pages has its common ancestor ABOVE both text
      // layers, so testing that would reject exactly the cross-page case the
      // chip is most useful for. Test the endpoints instead: either end being
      // in a text layer of this viewer means the selection is ours.
      const inTextLayer = (node: Node | null): boolean => {
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        return !!el && wrap.contains(el) && !!el.closest(".textLayer");
      };
      if (!inTextLayer(range.startContainer) && !inTextLayer(range.endContainer)) return;
      // Anchor to the last line rect (where the selection ends) rather than the
      // union box — across pages the union spans everything in between.
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      setChip({
        x: Math.min(Math.max(r.right - w.left, 8), Math.max(8, w.width - 130)),
        y: Math.min(Math.max(r.bottom - w.top + 8, 8), Math.max(8, w.height - 40)),
        text,
      });
    }, 0);
  }, [chatVisible]);

  // Dismiss the chip on click-elsewhere or when the selection collapses
  // (scrolling the pages dismisses via the scroll container below).
  useEffect(() => {
    if (!chip) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-quote-chip]")) setChip(null);
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setChip(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [chip]);

  useEffect(() => {
    if (!chatVisible) setChip(null);
  }, [chatVisible]);

  const pageWidth = Math.max(180, (containerWidth - 40) * zoom);

  return (
    <div className="flex h-full flex-col">
      {remoteStamp > 0 && (
        <div
          role="tablist"
          aria-label="PDF build source"
          className="flex shrink-0 items-center gap-1.5 border-b border-rule px-4 py-1.5 text-xs"
        >
          <button
            role="tab"
            aria-selected={!showingRemote}
            tabIndex={!showingRemote ? 0 : -1}
            onKeyDown={tabStripKeyDown}
            onClick={() => onSelectSource("local")}
            title="The local preflight build — checks your edits compile locally; Overleaf's own TeX Live may differ"
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              !showingRemote
                ? "border-gold bg-gold/10 text-gold"
                : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
            }`}
          >
            Local preflight
          </button>
          <button
            role="tab"
            aria-selected={showingRemote}
            tabIndex={showingRemote ? 0 : -1}
            onKeyDown={tabStripKeyDown}
            onClick={() => onSelectSource("remote")}
            title="Overleaf's own build — compiles the project as it currently is on Overleaf (approved & pushed changes, not unpushed local edits)"
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              showingRemote
                ? "border-gold bg-gold/10 text-gold"
                : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
            }`}
          >
            Overleaf build
          </button>
          {showingRemote && (
            <span className="ml-auto font-mono text-[11px] text-graphite">compiled on Overleaf</span>
          )}
        </div>
      )}

      {!showingRemote && compile && (
        <div
          role="status"
          title="Local preflight: checks your edits compile locally; Overleaf's own TeX Live may differ"
          className={`flex shrink-0 items-center gap-2 border-b border-rule px-4 py-1.5 text-xs ${
            compile.ok ? "text-leaf" : "text-pencil"
          }`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${compile.ok ? "bg-leaf" : "bg-pencil"}`} />
          {compile.ok
            ? `Local preflight (${compile.engine}) passed in ${(compile.durationMs / 1000).toFixed(1)}s`
            : `Local preflight failed (${compile.engine})`}
          <span className="ml-auto font-mono text-graphite">{compile.mainTex}</span>
        </div>
      )}

      {!showingRemote && compile && !compile.ok && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-rule bg-ink-2 px-4 py-3">
          {compile.errors.map((err, i) => (
            <pre key={i} className="mb-2 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-pencil">
              {err}
            </pre>
          ))}
        </div>
      )}

      {hasPdf && doc && (
        <div className="flex shrink-0 items-center gap-1 border-b border-rule px-3 py-1 text-xs text-paper-dim">
          <button
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / 1.15))}
            aria-label="Zoom out"
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-ink-3 hover:text-paper"
          >
            −
          </button>
          <span className="w-11 text-center font-mono text-[11px] text-graphite">
            {Math.round(zoom * 100)}%
          </span>
          {searchOpen ? (
            <span className="ml-1 flex items-center gap-1">
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    gotoHit(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
                placeholder="Find in PDF…"
                aria-label="Find in PDF"
                className="w-36 rounded border border-rule bg-ink-2 px-2 py-0.5 text-[11.5px] text-paper placeholder:text-graphite/60"
              />
              <span className="w-14 text-center font-mono text-[10.5px] text-graphite" role="status">
                {searching
                  ? "…"
                  : searchQuery.trim().length < 2
                    ? ""
                    : searchHits.length === 0
                      ? "no hits"
                      : `${searchIdx + 1}/${searchHits.length}`}
              </span>
              <button
                onClick={() => gotoHit(-1)}
                disabled={searchHits.length === 0}
                aria-label="Previous match"
                className="rounded px-1 transition-colors hover:bg-ink-3 hover:text-paper disabled:opacity-40"
              >
                ↑
              </button>
              <button
                onClick={() => gotoHit(1)}
                disabled={searchHits.length === 0}
                aria-label="Next match"
                className="rounded px-1 transition-colors hover:bg-ink-3 hover:text-paper disabled:opacity-40"
              >
                ↓
              </button>
              <button
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                aria-label="Close find"
                className="rounded px-1 transition-colors hover:bg-ink-3 hover:text-paper"
              >
                ×
              </button>
            </span>
          ) : (
            <button
              onClick={() => {
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              aria-label="Open find in PDF"
              title="Find in PDF (Ctrl+F)"
              className="rounded px-1.5 py-0.5 transition-colors hover:bg-ink-3 hover:text-paper"
            >
              ⌕
            </button>
          )}
          <button
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.15))}
            aria-label="Zoom in"
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-ink-3 hover:text-paper"
          >
            +
          </button>
          <button
            onClick={() => setZoom(1)}
            className="ml-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-ink-3 hover:text-paper"
          >
            Fit width
          </button>
          <span className="ml-auto font-mono text-[11px] text-graphite">
            {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
          </span>
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the PDF in a new tab"
            className="ml-2 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-ink-3 hover:text-paper"
            title="Open in a new tab"
          >
            open ↗
          </a>
        </div>
      )}

      <div ref={overlayRef} onMouseUp={handleMouseUp} className="relative min-h-0 flex-1">
        {/* Compile progress: a thin indeterminate bar plus a ticking status
            chip, floated over the (still visible) last PDF. Local builds only —
            the Overleaf build is unaffected by a local recompile. */}
        {compiling && !showingRemote && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
            <div className="compile-bar h-0.5 w-full" />
            <div className="mt-3 flex justify-center">
              <span className="rounded-full border border-rule bg-ink-2/95 px-3 py-1 font-mono text-[11px] text-gold shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
                {/* Only the stable part is live — the ticking seconds would
                    re-announce every half second. */}
                <span role="status">Compiling…</span> {elapsed}s
              </span>
            </div>
          </div>
        )}

        {chip && (
          <button
            type="button"
            data-quote-chip
            style={{ left: chip.x, top: chip.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setChip(null);
              const t = normalizePdfText(chip.text);
              onQuoteToChat(t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX).trimEnd()}…` : t);
            }}
            className="absolute z-20 rounded-full border border-rule bg-ink-2/95 px-2.5 py-1 text-[11.5px] text-paper-dim shadow-[0_2px_10px_rgba(0,0,0,0.45)] transition-colors hover:border-leaf hover:text-leaf"
          >
            ❝ quote in chat
          </button>
        )}

        {toast && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-rule bg-ink-2/95 px-3 py-1 text-xs text-pencil shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
          >
            {toast}
          </div>
        )}

        {hasPdf ? (
          <div
            ref={scrollRef}
            data-pdf-scroll
            onScroll={() => setChip(null)}
            className="h-full overflow-auto bg-[#3a3f4d] py-5"
          >
            {loadError && <p className="px-6 py-8 text-center text-sm text-pencil">{loadError}</p>}
            {doc &&
              Array.from({ length: doc.numPages }, (_, i) => (
                <PdfPage
                  key={`${doc.fingerprints[0]}-${i + 1}`}
                  doc={doc}
                  pageNo={i + 1}
                  width={pageWidth}
                  onLocate={locate}
                  highlight={findHl && findHl.page === i + 1 ? findHl : undefined}
                />
              ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-8">
            <p className="max-w-xs text-center font-serif text-sm leading-relaxed text-graphite">
              {compiling
                ? "Compiling the document…"
                : compile
                  ? "No PDF yet — fix the errors above and recompile."
                  : "No compile yet. Press Recompile, or ask BlattBot for an edit — it compiles automatically after each turn."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  pageNo,
  width,
  onLocate,
  highlight,
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  width: number;
  onLocate: (query: string) => void;
  /** A find hit on THIS page: scroll to and flash the matching spans. */
  highlight?: FindHighlight;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  /** The rendered text layer's spans and their item strings, for dblclick context. */
  const itemsRef = useRef<{ divs: HTMLElement[]; strs: string[] }>({ divs: [], strs: [] });
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState(Math.SQRT2); // height/width; A4 until measured
  /** A highlight waiting for the (lazily rendered) text layer. */
  const pendingHl = useRef<{ start: number; end: number } | null>(null);

  /**
   * Flash the text-layer spans covering the pending char range. The text
   * layer renders lazily (IntersectionObserver), so this runs both when the
   * highlight arrives (layer may already be up) and again after the layer
   * finishes rendering — whichever comes last applies it.
   */
  const applyHighlight = useCallback(() => {
    const hl = pendingHl.current;
    const { divs, strs } = itemsRef.current;
    if (!hl || divs.length === 0) return;
    pendingHl.current = null;
    let off = 0;
    const hit: HTMLElement[] = [];
    for (let i = 0; i < strs.length; i++) {
      const start = off;
      const end = off + strs[i].length;
      if (end > hl.start && start < hl.end && divs[i]) hit.push(divs[i]);
      off = end + 1; // the join space
      if (start >= hl.end) break;
    }
    if (hit.length === 0) return;
    hit[0].scrollIntoView({ block: "center" });
    for (const el of hit) el.classList.add("pdf-find-flash");
    window.setTimeout(() => {
      for (const el of hit) el.classList.remove("pdf-find-flash");
    }, FIND_FLASH_MS);
  }, []);

  // A new find hit: park it, pull the page into view (which triggers the lazy
  // text layer when it wasn't rendered yet), and apply if the layer is up.
  useEffect(() => {
    if (!highlight) return;
    pendingHl.current = { start: highlight.start, end: highlight.end };
    holderRef.current?.scrollIntoView({ block: "start" });
    applyHighlight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      } catch {
        /* render cancelled (zoom/recompile) or doc destroyed */
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNo, near, width]);

  // Selectable text overlay: mirrors the canvas lifecycle (same laziness,
  // re-rendered on zoom/resize, cancelled and cleared on the way out).
  useEffect(() => {
    if (!near || width <= 0) return;
    let cancelled = false;
    let layer: TextLayer | undefined;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = width / base.width;
        const textContent = await page.getTextContent();
        const container = textRef.current;
        if (cancelled || !container) return;
        container.replaceChildren();
        // pdfjs v6 sizes the layer and its glyphs off this CSS variable.
        container.style.setProperty("--scale-factor", String(scale));
        layer = new TextLayer({
          textContentSource: textContent,
          container,
          viewport: page.getViewport({ scale }),
        });
        itemsRef.current = { divs: layer.textDivs, strs: layer.textContentItemsStr };
        await layer.render();
        if (!cancelled) applyHighlight(); // a find may be waiting for this layer
      } catch {
        /* text layer cancelled or doc destroyed */
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, pageNo, near, width, applyHighlight]);

  /**
   * Double-click on a word: build a query from the word plus ~10 surrounding
   * words of this page's text and ask the server for the source position.
   */
  const handleDblClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target instanceof Element ? e.target.closest(".textLayer span") : null;
      if (!(target instanceof HTMLElement)) return;
      const { divs, strs } = itemsRef.current;
      const idx = divs.indexOf(target);
      if (idx < 0) return;
      const sel = window.getSelection();
      const word = sel?.toString().trim() ?? "";
      if (!word) return;
      // Character position of the click inside the page's joined text.
      let pos = 0;
      for (let i = 0; i < idx; i++) pos += strs[i].length + 1; // +1 for the join space
      if (sel?.anchorNode && target.contains(sel.anchorNode)) {
        pos += Math.min(sel.anchorOffset, strs[idx].length);
      } else {
        const p = strs[idx].indexOf(word);
        if (p > 0) pos += p;
      }
      const joined = strs.join(" ");
      const words: string[] = [];
      let wi = 0;
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(joined)) !== null) {
        if (m.index <= pos) wi = words.length;
        words.push(m[0]);
      }
      if (words.length === 0) return;
      const query = normalizePdfText(words.slice(Math.max(0, wi - 5), wi + 6).join(" "));
      if (query) onLocate(query);
    },
    [onLocate],
  );

  return (
    <div
      ref={holderRef}
      style={{ width, height: width * aspect }}
      className="relative mx-auto mb-5 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.35)]"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div ref={textRef} onDoubleClick={handleDblClick} className="textLayer" />
    </div>
  );
}
