import { appUrl } from "../urls";
import { RepositoryManager } from "./CodeRepositories";
import SidebarIcon from "./SidebarIcon";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type DirListing, type Project, type ProjectContext } from "../api";

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
  onOpenProjectSettings: () => void;
  /** Pull incoming remote changes now. Absent for local-only projects. */
  onSync?: () => void;
  syncing?: boolean;
  /** A newer published version exists — the footer links the releases page. */
  update?: { current: string; latest: string } | null;
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
  onOpenProjectSettings,
  onSync,
  syncing = false,
  update = null,
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
  // Folder picker: null = closed. A browser file input cannot hand back a real
  // path, so walking the filesystem server-side is the only way to link a repo
  // without typing its absolute path.
  const [browse, setBrowse] = useState<DirListing | null>(null);

  useEffect(() => {
    setCtx(null);
    setCtxErr(null);
    setBrowse(null);
    api.context(project.id).then(setCtx).catch(() => setCtx({ links: [], uploads: [] }));
  }, [project.id]);

  async function openBrowse(path?: string) {
    setCtxErr(null);
    try {
      setBrowse(await api.browseDirs(path));
    } catch (err: any) {
      setCtxErr(err.message);
    }
  }

  /** Runs a context mutation, showing its error. Returns whether it succeeded —
   *  a failed link must keep the typed path and the open browser. */
  async function ctxAction(fn: () => Promise<ProjectContext>): Promise<boolean> {
    setCtxBusy(true);
    setCtxErr(null);
    try {
      setCtx(await fn());
      return true;
    } catch (err: any) {
      setCtxErr(err.message);
      return false;
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
    const pad = { paddingLeft: `${8 + depth * 12}px` };
    return (
      <div key={node.path || "root"}>
        {node.path && (
          <button
            aria-expanded={!collapsed.has(node.path)}
            title={node.path}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            style={pad}
            className="flex h-8 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px] text-paper-dim transition-colors hover:bg-white/5 hover:text-paper"
          >
            <SidebarIcon name="chevron" className={`h-3 w-3 text-graphite transition-transform ${collapsed.has(node.path) ? "" : "rotate-90"}`} />
            <SidebarIcon name="folder" className="text-graphite" />
            <span className="truncate">{node.name}</span>
          </button>
        )}
        {(!node.path || !collapsed.has(node.path)) && (
          <>
            {node.dirs.map((d) => renderDir(d, node.path ? depth + 1 : depth))}
            {node.files.map((f) => (
              <label
                key={f.path}
                title={f.path}
                style={{ paddingLeft: `${8 + (node.path ? depth + 1 : depth) * 12}px` }}
                className={`group flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg pr-2 text-[11.5px] transition-colors ${
                  scopeSet.has(f.path) ? "bg-leaf/10 text-paper" : "text-paper-dim hover:bg-white/5"
                }`}
              >
                <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={scopeSet.has(f.path)}
                    onChange={() => toggleFile(f.path)}
                    aria-label={`Scope ${f.path}`}
                    className="peer h-3.5 w-3.5 appearance-none rounded-lg border border-graphite/40 bg-transparent transition-colors checked:border-leaf checked:bg-leaf group-hover:border-graphite"
                  />
                  <svg viewBox="0 0 16 16" className="pointer-events-none absolute inset-0 h-3.5 w-3.5 text-ink opacity-0 peer-checked:opacity-100" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 8 3 3 5-6" /></svg>
                </span>
                <span className="min-w-0 truncate">{f.name}</span>
                {f.path === project.mainTex && (
                  <span className="ml-auto shrink-0 rounded-lg bg-gold/10 px-1.5 py-0.5 text-[9px] text-gold/90">
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
    <nav aria-label="Project sidebar" className="flex w-60 shrink-0 flex-col border-r border-rule/60 bg-ink-2">
      <div className="px-3 pb-2 pt-3">
        <button
          onClick={onDashboard}
          aria-label="Back to dashboard"
          className="mb-3 flex h-7 items-center gap-1 rounded-lg px-1 text-[11px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim"
        >
          <SidebarIcon name="back" className="h-3.5 w-3.5" /> Dashboard
        </button>
        <div className="rounded-xl border border-rule/70 bg-white/[0.02] p-2">
          <div className="relative flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5 focus-within:ring-1 focus-within:ring-leaf">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-leaf/10 text-leaf"><SidebarIcon name="file" /></span>
            <div className="min-w-0 flex-1">
              <span className="text-[10px] text-graphite">Project</span>
              <h2 className="line-clamp-2 text-[12px] font-medium leading-[1.45] text-paper" title={project.name}>{project.name}</h2>
            </div>
            {projects.length > 1 && <SidebarIcon name="chevron" className="h-3 w-3 rotate-90 text-graphite" />}
            {projects.length > 1 && (
              <select
                value={project.id}
                onChange={(e) => onSelect(e.target.value)}
                aria-label="Switch project"
                title={project.name}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <button
              onClick={onOpenProjectSettings}
              aria-label="Open project settings"
              title="Writing style, model override, and default mode for this project"
              className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-[10.5px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim"
            >
              <SidebarIcon name="settings" className="h-3.5 w-3.5" /> Project settings
            </button>
            {onSync && (
              <button
                onClick={onSync}
                disabled={syncing}
                aria-label="Sync from remote"
                title="Pull incoming changes from Overleaf (or the git remote) now"
                className="ml-auto flex h-7 items-center gap-1 rounded-lg px-1.5 text-[10.5px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim disabled:opacity-60"
              >
                <SidebarIcon name="sync" className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Syncing" : "Sync"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-baseline gap-2 px-5 pb-2 pt-4">
        <span className="text-[11px] font-medium text-paper-dim">
          Files
        </span>
        <span className="ml-auto text-[10px] text-graphite" title="Select files to limit the agent's scope. No selection includes the whole project.">
          {scope.length === 0 ? "Whole project" : `${scope.length} file${scope.length > 1 ? "s" : ""}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {files.length === 0 ? (
          <p className="px-4 py-2 text-xs text-graphite">No files.</p>
        ) : (
          renderDir(tree, 0)
        )}
      </div>

      {scope.length > 0 && (
        <div className="px-3 pb-2">
          <button
            onClick={() => onScopeChange([])}
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim"
          >
            <SidebarIcon name="close" className="h-3 w-3" /> Clear file selection
          </button>
        </div>
      )}

      {/* External read-only context: reference material the agent may read but never edits. */}
      <div className="mx-3 mb-2 max-h-[42%] shrink-0 overflow-y-auto rounded-xl border border-rule/70 bg-white/[0.02] pb-2">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2">
          <span className="text-[11px] font-medium text-paper-dim">
            External context
          </span>
          {ctxCount > 0 && <span className="font-mono text-[10.5px] text-graphite/80">{ctxCount}</span>}
          <button
            onClick={() => setCtxOpen((s) => !s)}
            aria-label={ctxOpen ? "Close the external-context form" : "Add external context"}
            aria-expanded={ctxOpen}
            title={ctxOpen ? "Close" : "Add files or folders"}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim"
          >
            <SidebarIcon name={ctxOpen ? "close" : "plus"} className="h-3.5 w-3.5" />
          </button>
        </div>

        <RepositoryManager key={project.id} projectId={project.id} compact />
        {ctxOpen && (
          <div className="mx-3 mb-1.5 rounded-lg border border-rule bg-ink p-2">
            <label className="block text-[10.5px] text-graphite">
              Link a local path <span className="text-graphite/60">(code, data, notes — read-only)</span>
              <span className="mt-1 flex gap-1">
                <input
                  value={linkPath}
                  onChange={(e) => setLinkPath(e.target.value)}
                  placeholder="/home/…/my-experiment"
                  className="min-w-0 flex-1 rounded-lg border border-rule bg-ink-2 px-1.5 py-1 font-mono text-[10.5px] text-paper placeholder:text-graphite/60"
                />
                <button
                  disabled={ctxBusy || !linkPath.trim()}
                  onClick={() =>
                    ctxAction(() => api.addContextLink(project.id, linkPath.trim())).then(
                      (ok) => ok && setLinkPath(""),
                    )
                  }
                  className="rounded-lg border border-rule px-1.5 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                >
                  Link
                </button>
              </span>
            </label>
            <button
              onClick={() => (browse ? setBrowse(null) : void openBrowse(linkPath.trim() || undefined))}
              aria-expanded={browse !== null}
              className="mt-1.5 w-full rounded-lg border border-rule px-1.5 py-1 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
            >
              {browse ? "× Close folder browser" : "Browse folders…"}
            </button>

            {browse && (
              <div className="mt-1.5 rounded-lg border border-rule bg-ink-2 p-1">
                <div className="flex items-center gap-1">
                  <button
                    disabled={!browse.parent}
                    onClick={() => void openBrowse(browse.parent!)}
                    aria-label="Go to the parent folder"
                    className="rounded-lg border border-rule px-1 text-[10.5px] leading-[1.5] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-40"
                  >
                    ↑
                  </button>
                  {/* The tail identifies the folder you are standing in — a
                      plain truncate would cut exactly that away. Full path in
                      the tooltip, as in the linked list below. */}
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-graphite" title={browse.path}>
                    {browse.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || browse.path}
                  </span>
                </div>
                <ul className="mt-1 max-h-32 overflow-y-auto">
                  {browse.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        onClick={() => void openBrowse(e.path)}
                        className="w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10.5px] text-paper-dim transition-colors hover:bg-ink-3/60 hover:text-leaf"
                      >
                        {e.name}/
                      </button>
                    </li>
                  ))}
                  {browse.entries.length === 0 && (
                    <li className="px-1 py-0.5 text-[10px] text-graphite/70">no subfolders here</li>
                  )}
                </ul>
                <button
                  disabled={ctxBusy}
                  onClick={() =>
                    ctxAction(() => api.addContextLink(project.id, browse.path)).then(
                      (ok) => ok && setBrowse(null),
                    )
                  }
                  className="mt-1 w-full rounded-lg border border-rule px-1.5 py-1 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
                >
                  Link this folder
                </button>
              </div>
            )}

            <button
              disabled={ctxBusy}
              onClick={() => fileInput.current?.click()}
              className="mt-1.5 w-full rounded-lg border border-rule px-1.5 py-1 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf disabled:opacity-50"
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
          <p className="px-3 pb-1 pt-1 text-[10px] leading-relaxed text-graphite/70">
            Reference material · read-only
          </p>
        )}

        <ul>
          {ctx?.links.map((l) => (
            <li key={l.path} className="group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span className="text-graphite" title={l.kind === "dir" ? "linked folder" : "linked file"}>
                <SidebarIcon name={l.kind === "dir" ? "folder" : "file"} className="h-3.5 w-3.5" />
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
                className="rounded-md p-1 text-graphite/50 transition-colors hover:bg-white/5 hover:text-pencil focus-visible:text-paper group-hover:text-graphite"
              >
                <SidebarIcon name="close" className="h-3 w-3" />
              </button>
            </li>
          ))}
          {ctx?.uploads.map((u) => (
            <li key={u.name} className="group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span className="text-graphite" title="uploaded file">
                <SidebarIcon name="file" className="h-3.5 w-3.5" />
              </span>
              <a
                href={appUrl(`/api/projects/${project.id}/context/upload/${encodeURIComponent(u.name)}`)}
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
                className="rounded-md p-1 text-graphite/50 transition-colors hover:bg-white/5 hover:text-pencil focus-visible:text-paper group-hover:text-graphite"
              >
                <SidebarIcon name="close" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-3 pb-3 pt-1">
        <button
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[11.5px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim"
        >
          <SidebarIcon name="settings" /> Settings
        </button>
        {update && (
          <a
            href="https://github.com/LckyLke/blattbot/releases"
            target="_blank"
            rel="noreferrer"
            title="A newer BlattBot is published — open the release notes"
            className="block truncate rounded px-2.5 pb-1 pt-0.5 font-mono text-[10px] text-gold/70 transition-colors hover:text-gold"
          >
            v{update.current} → {update.latest} available
          </a>
        )}
      </div>
    </nav>
  );
}
