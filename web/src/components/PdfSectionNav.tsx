import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readPdfSections, type PdfSection } from "../pdf-outline";

export default function PdfSectionNav({ doc, scrollRef, pageWidth }: {
  doc: PDFDocumentProxy;
  scrollRef: RefObject<HTMLDivElement | null>;
  pageWidth: number;
}) {
  const [sections, setSections] = useState<PdfSection[]>([]);
  const [current, setCurrent] = useState(-1);
  const [status, setStatus] = useState("Loading sections…");
  const navigationTop = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSections([]);
    setCurrent(-1);
    navigationTop.current = null;
    setStatus("Loading sections…");
    void readPdfSections(doc).then(items => {
      if (cancelled) return;
      setSections(items);
      setStatus(items.length ? "" : "No section bookmarks in this PDF");
    }, () => { if (!cancelled) setStatus("Could not load PDF sections"); });
    return () => { cancelled = true; };
  }, [doc]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !sections.length) return;
    const update = () => {
      // Keep the chosen heading selected when the last page cannot scroll
      // far enough to place it at the top. Resume tracking on manual scroll.
      if (navigationTop.current !== null && Math.abs(container.scrollTop - navigationTop.current) < 2) return;
      navigationTop.current = null;
      const top = container.getBoundingClientRect().top;
      let active = -1;
      sections.forEach((section, index) => {
        const page = container.querySelector<HTMLElement>(`[data-pdf-page="${section.page}"]`);
        if (page && page.getBoundingClientRect().top - top + section.offset * pageWidth <= 24) active = index;
      });
      setCurrent(active);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [sections, pageWidth, scrollRef]);

  function jump(index: number) {
    const section = sections[index];
    const container = scrollRef.current;
    if (!section || !container) return;
    const page = container.querySelector<HTMLElement>(`[data-pdf-page="${section.page}"]`);
    if (!page) return;
    const top = page.getBoundingClientRect().top - container.getBoundingClientRect().top
      + container.scrollTop + section.offset * pageWidth - 12;
    navigationTop.current = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    container.scrollTo({ top: navigationTop.current, behavior: "instant" });
    setCurrent(index);
  }

  const buttonClass = "shrink-0 rounded px-2 py-1 hover:bg-ink-3 hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed";
  return <nav aria-label="PDF sections" className="flex shrink-0 items-center gap-1 border-b border-rule px-3 py-1 text-xs text-paper-dim">
    <button type="button" aria-label="Previous PDF section" title="Previous section" disabled={current <= 0} onClick={() => jump(current - 1)} className={buttonClass}>← Previous</button>
    <select aria-label="Jump to PDF section" value={current} disabled={!sections.length} onChange={event => jump(Number(event.target.value))} className="min-w-0 flex-1 rounded-lg border border-rule bg-ink-2 px-2 py-1 text-paper">
      <option value={-1} disabled>{status || "Jump to section…"}</option>
      {sections.map((section, index) => <option key={index} value={index}>{`${"　".repeat(Math.min(section.depth, 6))}${section.title} · p. ${section.page}`}</option>)}
    </select>
    <button type="button" aria-label="Next PDF section" title="Next section" disabled={!sections.length || current >= sections.length - 1} onClick={() => jump(current + 1)} className={buttonClass}>Next →</button>
  </nav>;
}
