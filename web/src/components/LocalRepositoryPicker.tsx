import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";

interface LocalRepository {
  path: string;
  branch: string | null;
  commit: string | null;
}
interface Listing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; gitRepository: boolean }[];
  truncated: boolean;
  repository: LocalRepository | null;
}
const lastFolderKey = "blattbot.localRepositoryFolder";
const control = "rounded-lg border border-rule px-3 py-2 text-xs text-paper-dim hover:border-leaf disabled:opacity-40";

export default function LocalRepositoryPicker({ projectId, initialPath, onSelect, onClose }: {
  projectId: string;
  initialPath: string;
  onSelect: (repository: LocalRepository) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [location, setLocation] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function navigate(path?: string) {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.research<Listing>(projectId, `/repositories/local${path ? `?path=${encodeURIComponent(path)}` : ""}`);
      if (generation.current !== request) return;
      setListing(next);
      setLocation(next.path);
      setFilter("");
    } catch (e) {
      if (generation.current === request) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }

  useEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    let recent: string | null = null;
    try { recent = localStorage.getItem(lastFolderKey); } catch { /* optional preference */ }
    const start = initialPath.trim() || recent || undefined;
    setLocation(start ?? "");
    void navigate(start);
    return () => {
      generation.current++;
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [projectId]);

  const repository = listing?.repository;
  const entries = listing?.entries.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const canSelect = !!repository?.commit && !loading && !error && location.trim() === listing?.path;

  return createPortal(
    <dialog ref={dialog} aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); onClose(); }}
      className="m-auto w-[620px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-rule bg-ink-2 p-5 text-paper shadow-2xl backdrop:bg-ink/80">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="font-sans text-lg">Choose a local Git repository</h2>
          <p className="mt-1 text-xs text-graphite">Browse folders on the computer running BlattBot.</p>
        </div>
        <button type="button" className={control} onClick={onClose} aria-label="Close folder picker">×</button>
      </div>
      <form className="mt-4" onSubmit={e => { e.preventDefault(); e.stopPropagation(); void navigate(location); }}>
        <label className="block text-xs text-paper-dim" htmlFor={`${titleId}-path`}>Folder location</label>
        <div className="mt-1 flex gap-2">
          <input id={`${titleId}-path`} value={location} disabled={loading} onChange={e => setLocation(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-rule bg-ink px-2 py-2 font-mono text-xs" placeholder="Paste a folder path, or use ~/Projects" />
          <button className={control} disabled={loading}>Go</button>
        </div>
      </form>
      <div className="my-3 flex gap-2">
        <button type="button" className={control} onClick={() => void navigate()} disabled={loading}>Home</button>
        <button type="button" className={control} onClick={() => void navigate(listing!.parent!)} disabled={loading || !listing?.parent}>↑ Up</button>
        <input aria-label="Filter folders" value={filter} onChange={e => setFilter(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-rule bg-ink px-2 py-2 text-xs" placeholder="Filter folders…" />
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="h-56 overflow-y-auto rounded-lg border border-rule bg-ink" aria-busy={loading}>
        {loading ? <p role="status" className="p-3 text-xs text-graphite">Reading folder…</p> :
          <ul>{entries.map(entry => <li key={entry.path}>
            <button type="button" onClick={() => void navigate(entry.path)}
              className="flex w-full items-center gap-3 border-b border-rule/50 px-3 py-2.5 text-left text-sm hover:bg-ink-3 hover:text-leaf"
              aria-label={`Open folder ${entry.name}`}>
              <span aria-hidden="true" className="text-graphite">▸</span>
              <span className="min-w-0 flex-1 break-all">{entry.name}</span>
              {entry.gitRepository && <span className="rounded-lg border border-leaf/40 px-1.5 py-0.5 text-[10px] text-leaf">Git</span>}
            </button>
          </li>)}</ul>}
        {!loading && !entries.length && <p className="p-3 text-xs text-graphite">{filter ? "No folders match your filter." : "No subfolders here."}</p>}
      </div>
      {listing?.truncated && <p className="mt-1 text-xs text-graphite">This folder has more than 500 entries. Paste a more specific path to reach folders not listed.</p>}
      <div className="mt-4 min-h-16 text-xs" aria-live="polite">
        {!loading && !error && repository ? <>
          <p className="font-medium text-leaf">Git repository found</p>
          <p className="mt-1 break-all font-mono text-paper-dim">{repository.path}</p>
          <p className="mt-1 text-graphite">{repository.branch ? `Branch: ${repository.branch}` : "Detached HEAD"}{repository.commit ? ` · ${repository.commit.slice(0, 12)}` : " · No commits yet"}</p>
          {!repository.commit && <p className="mt-1 text-graphite">Create an initial commit before attaching this repository.</p>}
        </> : !loading && !error && <p className="text-graphite">Open a Git repository to select it. Git badges help identify repository folders.</p>}
      </div>
      <p className="mt-3 text-xs text-graphite">The snapshot includes committed files. Uncommitted local edits stay out of the assessment.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={control} onClick={onClose}>Cancel</button>
        <button type="button" disabled={!canSelect}
          className="rounded-lg bg-leaf px-4 py-2 text-xs font-medium text-ink disabled:opacity-40"
          onClick={() => {
            if (!canSelect || !repository) return;
            try { localStorage.setItem(lastFolderKey, repository.path); } catch { /* optional preference */ }
            onSelect(repository);
          }}>Use this repository</button>
      </div>
    </dialog>, document.body,
  );
}
