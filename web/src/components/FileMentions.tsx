import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction, type RefObject, type KeyboardEvent } from "react";
import { api, type FileMention } from "../api";
import { insertMention, mentionQuery } from "../file-mentions";

export function useFileMentions(projectId: string, draft: string, setDraft: Dispatch<SetStateAction<string>>, input: RefObject<HTMLTextAreaElement | null>, busy: boolean) {
  const [range, setRange] = useState<ReturnType<typeof mentionQuery>>(null);
  const [choices, setChoices] = useState<FileMention[]>([]);
  const [selected, setSelected] = useState<FileMention[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [more, setMore] = useState(false);
  const listId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissed = useRef<string | null>(null);
  function close() {
    const el = input.current;
    dismissed.current = el ? JSON.stringify([el.value, el.selectionStart]) : null;
    setRange(null);
  }
  useEffect(() => { setRange(null); setSelected([]); setChoices([]); }, [projectId]);
  const query = range?.query;
  useEffect(() => {
    if (query === undefined || busy) return;
    let cancelled = false;
    setChoices([]); setIndex(0); setLoading(true); setNotice(""); setMore(false);
    const timer = window.setTimeout(() => {
      api.mentionFiles(projectId, query.trim()).then(result => {
        if (cancelled) return;
        setChoices(result.files); setMore(result.more); setNotice(result.warnings.join(" "));
      }).catch(error => { if (!cancelled) setNotice(error.message || "Could not load files."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projectId, query, busy]);
  const open = range !== null && !busy;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && event.target !== input.current) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, input]);
  useEffect(() => { document.getElementById(listId + "-" + index)?.scrollIntoView({ block: "nearest" }); }, [index, listId]);
  const activeMentions = selected.filter(item => draft.includes(item.token));
  function choose(item: FileMention) {
    if (!range) return;
    if (activeMentions.length >= 20 && !activeMentions.some(m => m.token === item.token)) {
      setNotice("You can mention up to 20 files per message."); return;
    }
    const next = insertMention(draft, range, item.token);
    setSelected([...activeMentions.filter(m => m.token !== item.token), item]);
    setDraft(next.text); setRange(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); close(); return true; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      setIndex(value => choices.length ? (value + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length : 0);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      if (choices[index] && !loading) choose(choices[index]);
      return true;
    }
    return false;
  }
  return {
    activeMentions, open, listId,
    activeId: open && choices[index] ? listId + "-" + index : undefined,
    close,
    update: (text: string, caret: number) => {
      if (dismissed.current === JSON.stringify([text, caret])) return;
      dismissed.current = null;
      setRange(mentionQuery(text, caret));
    },
    onKeyDown,
    panel: open && <div ref={panelRef} className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-rule bg-ink-2 shadow-xl">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2 text-[11px]">
        <span className="text-paper-dim">Mention a file</span><span className="text-graphite">↑↓ select · Enter · Esc</span>
      </div>
      <div id={listId} role="listbox" aria-label="File mentions" className="max-h-64 overflow-y-auto p-1">
        {choices.map((item, i) => <button key={item.token} id={listId + "-" + i} type="button" role="option" aria-selected={index === i}
          tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}
          className={"flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-xs " + (index === i ? "bg-white/5 text-paper" : "text-paper-dim hover:bg-white/[0.03]")}>
          <span className="min-w-0 flex-1 truncate">{item.path}</span>
          <span className="max-w-[45%] truncate text-[10px] text-graphite">{item.label}{item.commit ? " · " + item.commit.slice(0, 7) : ""}</span>
        </button>)}
      </div>
      {(loading || !choices.length || notice || more) && <div role="status" className="border-t border-rule px-3 py-2 text-[11px] text-graphite">
        {loading ? "Finding files…" : notice || (more ? "Type more of the path to narrow the results." : !choices.length ? "No matching files." : "")}
      </div>}
    </div>,
  };
}
