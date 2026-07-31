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
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const QUOTE_MAX = 600;

/**
 * Normalize text lifted from the PDF text layer: drop soft hyphens, expand
 * ligatures (ﬁ→fi, …), rejoin line-break hyphenation ("exam- ple" →
 * "example"), and collapse whitespace.
 */
function normalizePdfText(s: string): string {
  return s
    .replace(/\u00AD/g, "")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/([A-Za-z])-\s+(?=[a-z])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
      const node = range.commonAncestorContainer;
      const el = node instanceof Element ? node : node.parentElement;
      if (!el || !wrap.contains(el) || !el.closest(".textLayer")) return;
      const r = range.getBoundingClientRect();
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
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  width: number;
  onLocate: (query: string) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  /** The rendered text layer's spans and their item strings, for dblclick context. */
  const itemsRef = useRef<{ divs: HTMLElement[]; strs: string[] }>({ divs: [], strs: [] });
  const [near, setNear] = useState(false);
  const [aspect, setAspect] = useState(Math.SQRT2); // height/width; A4 until measured

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
      } catch {
        /* text layer cancelled or doc destroyed */
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [doc, pageNo, near, width]);

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
