import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Project, type ProjectContext } from "../api";

interface Props {
  /** All imported projects, for the quick switcher. */
  projects: Project[];
  /** The open project. */
  project: Project;
  /** Its file list (relative paths). */
  files: string[];
  /** Checked files = the agent's edit scope for the next message. Empty = whole project. */
  scope: string[];
  onScopeChange: (scope: string[]) => void;
  onSelect: (id: string) => void;
  onDashboard: () => void;
  onOpenSettings: () => void;
}

interface DirNode {
  path: string;
  name: string;
  dirs: DirNode[];
  files: { path: string; name: string }[];
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { path: "", name: "", dirs: [], files: [] };
  for (const p of paths) {
    const segs = p.split("/");
    const name = segs.pop()!;
    let cur = root;
    for (const seg of segs) {
      let next = cur.dirs.find((d) => d.name === seg);
      if (!next) {
        next = { path: cur.path ? `${cur.path}/${seg}` : seg, name: seg, dirs: [], files: [] };
        cur.dirs.push(next);
      }
      cur = next;
    }
    cur.files.push({ path: p, name });
  }
  return root;
}

/**
 * Project-view left rail: back-to-dashboard navigation, a quick project
 * switcher, and the file tree as a context selector — checked files scope the
 * agent's next message.
 */
export default function Sidebar({
  projects,
  project,
  files,
  scope,
  onScopeChange,
  onSelect,
  onDashboard,
  onOpenSettings,
}: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scopeSet = useMemo(() => new Set(scope), [scope]);

  // --- External read-only context ---
  const [ctx, setCtx] = useState<ProjectContext | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [linkPath, setLinkPath] = useState("");
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [ctxBusy, setCtxBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCtx(null);
    setCtxErr(null);
    api.context(project.id).then(setCtx).catch(() => setCtx({ links: [], uploads: [] }));
  }, [project.id]);

  async function ctxAction(fn: () => Promise<ProjectContext>) {
    setCtxBusy(true);
    setCtxErr(null);
    try {
      setCtx(await fn());
    } catch (err: any) {
      setCtxErr(err.message);
    } finally {
      setCtxBusy(false);
    }
  }

  async function uploadFiles(list: FileList) {
    for (const file of Array.from(list)) {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      await ctxAction(() => api.uploadContext(project.id, file.name, { contentBase64: btoa(binary) }));
    }
  }

  const ctxCount = (ctx?.links.length ?? 0) + (ctx?.uploads.length ?? 0);

  function toggleFile(path: string) {
    onScopeChange(scope.includes(path) ? scope.filter((p) => p !== path) : [...scope, path]);
  }

  function renderDir(node: DirNode, depth: number): ReactNode {
    const pad = { paddingLeft: `${10 + depth * 12}px` };
    return (
      <div key={node.path || "root"}>
        {node.path && (
          <button
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            style={pad}
            className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[11.5px] text-paper-dim hover:text-paper"
          >
            <span className="text-[9px] text-graphite">{collapsed.has(node.path) ? "▸" : "▾"}</span>
            <span className="truncate">{node.name}/</span>
          </button>
        )}
        {(!node.path || !collapsed.has(node.path)) && (
          <>
            {node.dirs.map((d) => renderDir(d, node.path ? depth + 1 : depth))}
            {node.files.map((f) => (
              <label
                key={f.path}
                style={{ paddingLeft: `${10 + (node.path ? depth + 1 : depth) * 12}px` }}
                className={`flex w-full cursor-pointer items-baseline gap-1.5 py-1 pr-2 font-mono text-[11.5px] transition-colors ${
                  scopeSet.has(f.path) ? "bg-leaf/10 text-paper" : "text-paper-dim hover:bg-ink-3/50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={scopeSet.has(f.path)}
                  onChange={() => toggleFile(f.path)}
                  aria-label={`Scope ${f.path}`}
                  className="translate-y-[1px] accent-leaf"
                />
                <span className="truncate">{f.name}</span>
                {f.path === project.mainTex && (
                  <span className="rounded-sm border border-gold/40 px-1 text-[8.5px] uppercase tracking-wide text-gold">
                    main
                  </span>
                )}
              </label>
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-rule bg-ink-2">
      <div className="border-b border-rule px-3 pb-3 pt-3">
        <button
          onClick={onDashboard}
          aria-label="Back to dashboard"
          className="rounded px-1 py-0.5 text-[12px] text-graphite transition-colors hover:text-leaf"
        >
          ‹ Dashboard
        </button>
        <h2 className="mt-1.5 truncate px-1 font-serif text-[15px] text-paper" title={project.name}>
          {project.name}
        </h2>
        {projects.length > 1 && (
          <select
            value={project.id}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Switch project"
            className="mt-2 w-full rounded border border-rule bg-ink px-1.5 py-1 text-[11.5px] text-paper-dim"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex items-baseline gap-2 px-4 pb-1 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
          Context
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-graphite/80">
          {scope.length === 0 ? "whole project" : `${scope.length} file${scope.length > 1 ? "s" : ""}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-0.5">
        {files.length === 0 ? (
          <p className="px-4 py-2 text-xs text-graphite">No files.</p>
        ) : (
          renderDir(tree, 0)
        )}
      </div>

      {scope.length > 0 && (
        <div className="border-t border-rule px-3 py-1.5">
          <button
            onClick={() => onScopeChange([])}
            className="w-full rounded px-1.5 py-1 text-left text-[11px] text-graphite transition-colors hover:text-paper-dim"
          >
            × clear scope — edit whole project
          </button>
        </div>
      )}

      {/* External read-only context: reference material the agent may read but never edits. */}
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-rule pb-1.5">
        <div className="flex items-baseline gap-2 px-4 pb-1 pt-2.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-graphite">
            External context
          </span>
          {ctxCount > 0 && <span className="font-mono text-[10.5px] text-graphite/80">{ctxCount}</span>}
          <button
            onClick={() => setCtxOpen((s) => !s)}
            aria-label="Add external context"
            className="ml-auto rounded border border-rule px-1.5 text-[11px] leading-[1.4] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
          >
            {ctxOpen ? "×" : "+"}
          </button>
        </div>

        {ctxOpen && (
          <div className="mx-3 mb-1.5 rounded border border-rule bg-ink p-2">
            <label className="block text-[10.5px] text-graphite">
              Link a local path <span className="text-graphite/60">(code, data, notes — read-only)</span>
              <span className="mt-1 flex gap-1">
                <input
                  value={linkPath}
                  onChange={(e) => setLinkPath(e.target.value)}
                  placeholder="/home/…/my-experiment"
                  className="min-w-0 flex-1 rounded border border-rule bg-ink-2 px-1.5 py-1 font-mono text-[10.5px] text-paper placeholder:text-graphite/60"
                />
                <button
                  disabled={ctxBusy || !linkPath.trim()}
                  onClick={() =>
                    ctxAction(() => api.addContextLink(project.id, linkPath.trim())).then(() =>
                      setLinkPath(""),
                    )
                  }
                  className="rounded border border-rule px-1.5 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                >
                  Link
                </button>
              </span>
            </label>
            <button
              disabled={ctxBusy}
              onClick={() => fileInput.current?.click()}
              className="mt-1.5 w-full rounded border border-rule px-1.5 py-1 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
            >
              Upload files (PDFs, notes, results…)
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {ctxErr && <p className="mt-1 text-[10.5px] leading-snug text-pencil">{ctxErr}</p>}
          </div>
        )}

        {ctx && ctxCount === 0 && !ctxOpen && (
          <p className="px-4 pb-1 text-[10.5px] leading-snug text-graphite/70">
            Attach code, data, or papers the agent may read but never edit.
          </p>
        )}

        <ul>
          {ctx?.links.map((l) => (
            <li key={l.path} className="group flex items-center gap-1.5 py-0.5 pl-4 pr-2">
              <span className="text-[10px] text-graphite" title={l.kind === "dir" ? "linked folder" : "linked file"}>
                {l.kind === "dir" ? "▣" : "▤"}
              </span>
              <span
                className={`min-w-0 flex-1 truncate font-mono text-[10.5px] ${l.exists ? "text-paper-dim" : "text-pencil line-through"}`}
                title={l.exists ? l.path : `${l.path} (missing)`}
              >
                {l.path.split("/").filter(Boolean).slice(-2).join("/")}
              </span>
              <button
                onClick={() => ctxAction(() => api.removeContextLink(project.id, l.path))}
                aria-label={`Unlink ${l.path}`}
                className="hidden rounded px-1 text-[11px] text-graphite hover:text-pencil group-hover:block"
              >
                ×
              </button>
            </li>
          ))}
          {ctx?.uploads.map((u) => (
            <li key={u.name} className="group flex items-center gap-1.5 py-0.5 pl-4 pr-2">
              <span className="text-[10px] text-graphite" title="uploaded file">
                ▥
              </span>
              <a
                href={`/api/projects/${project.id}/context/upload/${encodeURIComponent(u.name)}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-paper-dim hover:text-leaf"
                title={`${u.name} · ${u.size < 1024 * 1024 ? `${Math.max(1, Math.round(u.size / 1024))} KB` : `${(u.size / 1024 / 1024).toFixed(1)} MB`}`}
              >
                {u.name}
              </a>
              <button
                onClick={() => ctxAction(() => api.deleteContextUpload(project.id, u.name))}
                aria-label={`Delete ${u.name}`}
                className="hidden rounded px-1 text-[11px] text-graphite hover:text-pencil group-hover:block"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-rule px-2 py-1.5">
        <button
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="w-full rounded px-2.5 py-1.5 text-left text-[12px] text-graphite transition-colors hover:bg-ink-3/60 hover:text-paper-dim"
        >
          ⚙ Settings
        </button>
      </div>
    </nav>
  );
}
