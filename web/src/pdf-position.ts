import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { relocatePdfReadingPosition } from "./pdf-reading-anchor";

interface ReadingPosition {
  page: number;
  /** Distance from the page top, in page widths (independent of zoom/layout). */
  offset: number;
  left: number;
  zoom: number;
}

export function readPdfPosition(key: string): ReadingPosition | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(`blattbot.pdfPosition:${key}`) ?? "null");
    return p && Number.isInteger(p.page) && p.page > 0 &&
      [p.offset, p.left, p.zoom].every(Number.isFinite) && p.zoom >= 0.4 && p.zoom <= 4 ? p : null;
  } catch { return null; }
}

/** Keep a page-relative bookmark while hidden, loading, or resolving lazy page sizes. */
export function usePdfPosition(
  key: string,
  scrollRef: RefObject<HTMLDivElement | null>,
  doc: PDFDocumentProxy | null,
  width: number,
  visible: boolean,
  zoom: number,
  navigating: boolean,
) {
  const [initialPosition] = useState(() => readPdfPosition(key));
  const position = useRef<ReadingPosition | null>(initialPosition);
  const restoring = useRef(false);
  const interaction = useRef(0);
  const save = () => {
    if (!position.current) return;
    position.current.zoom = zoom;
    try { sessionStorage.setItem(`blattbot.pdfPosition:${key}`, JSON.stringify(position.current)); } catch { /* storage unavailable */ }
  };
  const remember = () => {
    const container = scrollRef.current;
    if (!visible || !doc || !container?.clientWidth || restoring.current) return;
    const bounds = container.getBoundingClientRect();
    const pages = [...container.querySelectorAll<HTMLElement>("[data-pdf-page]")];
    const page = pages.find(p => p.getBoundingClientRect().bottom > bounds.top) ?? pages.at(-1);
    if (!page) return;
    const rect = page.getBoundingClientRect();
    if (!rect.width) return;
    position.current = { page: Number(page.dataset.pdfPage), offset: (bounds.top - rect.top) / rect.width,
      left: container.scrollLeft / rect.width, zoom };
    save();
  };

  // Only layout/document changes trigger restoration. Releasing a link
  // destination during a wheel gesture must not immediately pin it again.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!doc || !visible || !container?.clientWidth) return;
    save();
    if (navigating) return;
    if (!position.current) remember();
    const target = position.current;
    if (!target) return;
    restoring.current = true;
    const restore = () => {
      if (!restoring.current || !container.clientWidth) return;
      const page = container.querySelector<HTMLElement>(`[data-pdf-page="${Math.min(target.page, doc.numPages)}"]`);
      if (!page) return;
      const rect = page.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + rect.top - container.getBoundingClientRect().top + target.offset * rect.width,
        left: target.left * rect.width, behavior: "instant" });
    };
    restore();
    const observer = new ResizeObserver(restore);
    container.querySelectorAll("[data-pdf-page]").forEach(p => observer.observe(p));
    return () => observer.disconnect();
  }, [doc, width, visible, key, zoom]);

  return {
    remember,
    prepareReplacement: async (next: PDFDocumentProxy, cancelled: () => boolean) => {
      remember();
      const saved = position.current;
      const generation = interaction.current;
      if (!doc || !saved) return;
      const stale = () => cancelled() || interaction.current !== generation || position.current !== saved;
      const relocated = await relocatePdfReadingPosition(doc, next, saved, stale);
      if (!stale()) { position.current = { ...saved, ...relocated }; save(); }
    },
    // User navigation takes precedence over a pending layout restoration.
    release: () => { interaction.current++; restoring.current = false; },
  };
}
