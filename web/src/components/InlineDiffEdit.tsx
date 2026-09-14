import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { countDrafts, dropDraft, readDraft, stashDraft } from "../drafts";
import { countFileSaves, notifyEditors, startFileSave, subscribeEditors } from "../editor-sync";
import { passageRange, type DiffLine } from "../diff";

export const InlineDiffContext = createContext<{
  projectId: string; busy: boolean; onDiff: (diff: string) => void; onSaved: () => void;
} | null>(null);

export default function InlineDiffEdit({ path, lines }: { path: string; lines: DiffLine[] }) {
  const context = useContext(InlineDiffContext)!;
  const { projectId, busy, onDiff, onSaved } = context;
  const [edit, setEdit] = useState<{ base: string; start: number; end: number; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const origin = useRef(Symbol("inline-proof")).current;
  const owned = useRef<string | null>(null);
  const mounted = useRef(true);
  const tap = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => subscribeEditors(update => {
    if (update.projectId === projectId && update.path === path && update.origin !== origin && update.kind === "document") {
      setStale(true);
      setError("This file was edited elsewhere. Your latest draft is available in the Source editor.");
    }
  }), [projectId, path, origin]);

  async function begin() {
    if (edit || loading || busy) return;
    if (countDrafts(projectId) || countFileSaves(projectId)) {
      setError("Save or discard your existing draft before editing this passage."); return;
    }
    setLoading(true); setError("");
    try {
      const file = await api.file(projectId, path);
      if (!mounted.current) return;
      if (file.binary) throw new Error("This file cannot be edited as text.");
      if (countDrafts(projectId) || countFileSaves(projectId)) throw new Error("Another editor has unsaved changes. Save those first.");
      setEdit({ base: file.content, ...passageRange(file.content, lines) });
      setStale(false);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }
  function change(text: string) {
    if (!edit) return;
    const content = edit.base.slice(0, edit.start) + text + edit.base.slice(edit.end);
    owned.current = content;
    if (content === edit.base) dropDraft(projectId, path);
    else stashDraft(projectId, path, { base: edit.base, content });
    notifyEditors({ projectId, path, origin, kind: "document", content, saved: edit.base });
    setEdit({ ...edit, text });
  }
  function cancel() {
    if (saving) return;
    if (edit && !stale && readDraft(projectId, path)?.content === owned.current) {
      dropDraft(projectId, path);
      notifyEditors({ projectId, path, origin, kind: "document", content: edit.base, saved: edit.base });
    }
    setEdit(null); setError(""); owned.current = null;
  }
  async function save() {
    if (!edit || saving || busy || stale) return;
    const finish = startFileSave(projectId, path, origin);
    if (!finish) return;
    setSaving(true); setError("");
    const content = edit.base.slice(0, edit.start) + edit.text + edit.base.slice(edit.end);
    let live = content;
    const stopTracking = subscribeEditors(update => {
      if (update.projectId === projectId && update.path === path && update.kind === "document") live = update.content;
    });
    try {
      const result = await api.saveFile(projectId, path, content, edit.base);
      // A second editor may have kept typing while the request was in flight.
      if (live === content) dropDraft(projectId, path);
      else stashDraft(projectId, path, { content: live, base: content });
      notifyEditors({ projectId, path, origin, kind: "document", content: live, saved: content });
      setEdit(null); owned.current = null;
      onDiff(result.diff); onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { stopTracking(); setSaving(false); finish(); }
  }
  return <>
    {edit ? <div className="min-w-0 py-2 pr-3">
      <textarea autoFocus aria-label={`Edit added passage in ${path}`} value={edit.text}
        disabled={saving || stale || busy} rows={Math.min(18, Math.max(3, edit.text.split("\n").length + 1))}
        spellCheck={false} onChange={event => change(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
        }}
        className="block w-full min-w-0 resize-y rounded border border-leaf/60 bg-ink-2 p-2 font-mono text-[12.5px] leading-[1.55] text-paper outline-none focus:ring-1 focus:ring-leaf disabled:opacity-60" />
      <div className="mt-2 flex flex-wrap items-center gap-2 font-sans text-xs">
        <button onClick={() => void save()} disabled={saving || stale || busy} className="rounded bg-leaf px-3 py-1 text-ink disabled:opacity-50">{saving ? "Saving…" : "Save passage"}</button>
        <button onClick={cancel} disabled={saving} className="rounded border border-rule px-3 py-1">{stale ? "Close" : "Cancel"}</button>
        <span className="text-graphite">Ctrl/⌘ + Enter to save · Esc to cancel</span>
      </div>
    </div> : <div role="button" tabIndex={busy ? -1 : 0} aria-label={`Edit added passage in ${path} at line ${lines[0].newNo}`}
      title="Double-click or double-tap to edit this passage. Enter also opens the editor."
      onDoubleClick={() => void begin()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void begin(); } }}
      onPointerUp={event => { if (event.pointerType !== "touch") return; const now = Date.now(); if (now - tap.current < 350) void begin(); tap.current = now; }}
      className="cursor-text whitespace-pre-wrap break-all pr-3 outline-none focus-visible:ring-1 focus-visible:ring-leaf hover:bg-leaf/10">
      {lines.map((line, index) => <div key={index}>{line.text || " "}</div>)}{loading && <span className="ml-2 text-graphite">Opening…</span>}
    </div>}
    {error && <p role="alert" className="py-2 pr-3 font-sans text-xs text-pencil">{error}</p>}
  </>;
}
