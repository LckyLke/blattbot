import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { api } from "../api";
import Markdown from "./Markdown";

type Passage = { text: string; context: string; location: string; x: number; y: number };
type Message = { role: "user" | "assistant"; text: string; passage?: Pick<Passage, "text" | "context" | "location"> };

/** Selection-local, tool-free questions; never enters the main chat transcript. */
export default function InlineQuestion({ projectId }: { projectId: string }) {
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [candidate, setCandidate] = useState<Passage | null>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const latest = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (open && !pending) input.current?.focus(); }, [open, passage, pending]);
  useEffect(() => { latest.current?.scrollIntoView({ block: "nearest" }); }, [messages, pending]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function capture(event: Event) {
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest("[data-inline-question], [data-quote-chip]")) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        let text = "", context = "", location = "Selected text";
        let rect: { left: number; top: number; bottom: number } | undefined;
        let anchor: Element | null = target;
        const cm = target.closest<HTMLElement>(".cm-editor");
        if (cm) {
          const view = EditorView.findFromDOM(cm);
          const range = view?.state.selection.main;
          if (view && range && !range.empty) {
            text = view.state.sliceDoc(range.from, range.to);
            context = view.state.sliceDoc(Math.max(0, range.from - 2000), Math.min(view.state.doc.length, range.to + 2000));
            const start = view.coordsAtPos(range.from);
            if (start) rect = start;
            location = `${cm.closest<HTMLElement>("[data-selection-location]")?.dataset.selectionLocation || "Source"}:${view.state.doc.lineAt(range.from).number}`;
          }
        } else if (target instanceof HTMLTextAreaElement && target.closest("#pane-panel-proof, [data-source-panel]")) {
          text = target.value.slice(target.selectionStart, target.selectionEnd);
          context = target.value.slice(Math.max(0, target.selectionStart - 2000), target.selectionEnd + 2000);
          rect = target.getBoundingClientRect();
          location = target.closest<HTMLElement>("[data-selection-location]")?.dataset.selectionLocation || "Proof editor";
        } else if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
            if (!anchor?.closest(".blattbot-workspace") || anchor.closest("[data-inline-question], .blattbot-sidebar")) return;
            text = selection.toString();
            rect = range.getClientRects()[0] || range.getBoundingClientRect();
            location = anchor.closest<HTMLElement>("[data-selection-location]")?.dataset.selectionLocation || anchor.closest('[role="tabpanel"]')?.getAttribute("aria-label") || "Selected text";
            // Keep surrounding context bounded and visibly tied to the selected block.
            context = anchor.closest("p, tr, blockquote, .textLayer")?.textContent?.slice(0, 16000) || "";
          }
        }
        if (!text.trim() || !rect) { setCandidate(null); return; }
        setCandidate({ text, context: context.slice(0, 16000), location, x: rect.left, y: rect.top });
      }, 30);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { setCandidate(null); }
    }
    function dismiss() { setCandidate(null); }
    function resize() { dismiss(); setViewport({ width: window.innerWidth, height: window.innerHeight }); }
    document.addEventListener("pointerup", capture);
    document.addEventListener("keyup", capture);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerup", capture);
      document.removeEventListener("keyup", capture);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, []);

  function close() {
    setOpen(false);
    previousFocus.current?.focus({ preventScroll: true });
  }
  function begin() {
    if (!candidate) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPosition(current => current ?? { x: candidate.x, y: candidate.y + 24 });
    setPassage(candidate); setCandidate(null); setError(""); setOpen(true);
  }
  function clear() {
    controller.current?.abort(); controller.current = null;
    setMessages([]); setQuestion(""); setError(""); setPending(false);
    input.current?.focus();
  }
  function clamp(x: number, y: number) {
    return { x: Math.max(8, Math.min(x, viewport.width - Math.min(440, viewport.width - 16) - 8)),
      y: Math.max(8, Math.min(y, viewport.height - Math.min(570, viewport.height - 16) - 8)) };
  }
  const placed = clamp(position?.x ?? passage?.x ?? 8, position?.y ?? (passage?.y ?? 8) + 24);
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!passage || !question.trim() || pending || messages.length >= 12 || passage.text.length > 12000) return;
    const prompt = question.trim();
    const next: Message[] = [...messages, { role: "user", text: prompt, passage: { text: passage.text, context: passage.context, location: passage.location } }];
    const request = new AbortController(); controller.current = request;
    setPending(true); setError(""); setMessages(next); setQuestion("");
    try {
      const result = await api.inlineQuestion(projectId, { selection: passage.text, context: passage.context, location: passage.location, messages: next }, request.signal);
      if (controller.current !== request) return;
      setMessages([...next, { role: "assistant", text: result.answer }]);
    } catch (err) {
      if (controller.current !== request) return;
      setMessages(messages); setQuestion(prompt);
      setError(request.signal.aborted ? "Stopped. You can ask again." : (err as Error).message);
    } finally {
      if (controller.current === request) { setPending(false); controller.current = null; input.current?.focus(); }
    }
  }
  return createPortal(<div data-inline-question>
    {candidate && <button type="button" onPointerDown={event => event.preventDefault()} onClick={begin}
      style={{ position: "fixed", left: Math.max(8, Math.min(candidate.x, viewport.width - 115)), top: Math.max(8, candidate.y - 38), zIndex: 10010 }}
      className="rounded-full border border-leaf/60 bg-ink-2 px-3 py-1.5 text-xs text-leaf shadow-lg hover:bg-ink-3">Ask inline</button>}
    {passage && !open && <button onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-[10000] rounded-full border border-leaf/50 bg-ink-2 px-4 py-2 text-xs text-leaf shadow-lg">{pending ? "Answering…" : "Quick question"}</button>}
    {open && passage && <div ref={panel} role="dialog" aria-label="Inline question" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
      style={{ left: placed.x, top: placed.y }}
      className="fixed z-[10000] flex max-h-[min(570px,calc(100dvh-16px))] w-[440px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-rule bg-ink-2 text-paper shadow-[0_16px_64px_rgba(0,0,0,.5)]">
      <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
        <button type="button" aria-label="Move inline question" title="Drag to move · Arrow keys to move with the keyboard"
          className="min-w-0 flex-1 touch-none cursor-grab select-none text-left active:cursor-grabbing"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: placed.x, top: placed.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            setPosition(clamp(start.left + event.clientX - start.x, start.top + event.clientY - start.y));
          }}
          onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={event => {
            const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const move = moves[event.key]; if (!move) return;
            event.preventDefault(); const step = event.shiftKey ? 40 : 10;
            setPosition(clamp(placed.x + move[0] * step, placed.y + move[1] * step));
          }}>
          <span className="block font-serif text-base">⠿ Quick question</span><span className="block truncate text-[11px] text-graphite">{passage.location} · Separate from main chat</span>
        </button>
        <button type="button" aria-label="Clear inline conversation" title="Clear messages and start fresh with the current passage" onClick={clear} className="rounded border border-rule px-2 py-1 text-xs text-paper-dim hover:bg-ink-3">Clear</button>
        <button aria-label="Minimize inline question" onClick={close} className="rounded px-2 py-1 text-paper-dim hover:bg-ink-3">×</button>
      </header>
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <details className="mb-3 rounded border border-leaf/20 bg-leaf/5 px-3 py-2"><summary className="cursor-pointer truncate text-xs text-paper-dim">“{passage.text.slice(0, 120)}{passage.text.length > 120 ? "…" : ""}”</summary><p className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap text-xs text-paper-dim">{passage.text}</p></details>
        {!messages.length && <p className="mb-2 text-xs text-graphite">Ask about this passage. The model sees the selection and nearby text, not the full paper.</p>}
        {messages.map((message, i) => <div key={i} className={`mb-3 ${message.role === "user" ? "rounded-lg bg-ink-3 px-3 py-2" : "px-1"}`}><span className="mb-1 block text-[10px] uppercase tracking-wide text-graphite">{message.role === "user" ? "You" : "BlattBot"}</span>{message.passage && <details className="mb-1 text-[11px] text-graphite"><summary className="cursor-pointer truncate">{message.passage.location}</summary><p className="max-h-24 overflow-y-auto whitespace-pre-wrap">{message.passage.text}</p></details>}<Markdown text={message.text} className="text-sm" /></div>)}
        {pending && <p role="status" className="py-2 text-xs text-leaf">Thinking about your question…</p>}
        {error && <p role="alert" className="py-2 text-xs text-pencil">{error}</p>}
        {passage.text.length > 12000 && <p role="alert" className="text-xs text-pencil">Select a shorter passage (up to 12,000 characters).</p>}
        {messages.length >= 12 && <p className="text-xs text-graphite">Clear this conversation to ask more questions.</p>}
        <div ref={latest} />
      </div>
      <form onSubmit={ask} className="border-t border-rule p-3">
        <textarea ref={input} disabled={pending} aria-label="Inline question" placeholder={messages.length ? "Ask a follow-up…" : "What would you like to understand?"} value={question} onChange={event => setQuestion(event.target.value)} rows={2} maxLength={16000}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          className="block w-full resize-none rounded-lg border border-rule bg-ink p-2 text-sm outline-none focus:border-leaf" />
        <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-graphite">Enter to ask · Shift+Enter for a new line</span>
          {pending ? <button type="button" onClick={() => controller.current?.abort()} className="rounded border border-rule px-3 py-1 text-xs">Stop</button> : <button disabled={!question.trim() || messages.length >= 12 || passage.text.length > 12000} className="rounded bg-leaf px-3 py-1 text-xs text-ink disabled:opacity-40">Ask</button>}
        </div>
      </form>
    </div>}
  </div>, document.body);
}
