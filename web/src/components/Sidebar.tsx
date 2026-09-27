import { appUrl } from "../urls";
import { RepositoryManager } from "./CodeRepositories";
import SidebarIcon from "./SidebarIcon";
import { useEffect, useRef, useState } from "react";
import { api, type ChatMeta, type DirListing, type Project, type ProjectContext } from "../api";

interface Props {
  /** All imported projects, for the quick switcher. */
  projects: Project[];
  /** The open project. */
  project: Project;
  chats: ChatMeta[];
  activeChatId: string | null;
  busy: boolean;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
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

/** Project navigation, persistent chat history, and attached reference material. */
export default function Sidebar({
  projects,
  project,
  chats,
  activeChatId,
  busy,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onSelect,
  onDashboard,
  onOpenSettings,
  onOpenProjectSettings,
  onSync,
  syncing = false,
  update = null,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [chatFilter, setChatFilter] = useState("");
  useEffect(() => { setConfirmDelete(null); setChatFilter(""); }, [project.id, activeChatId]);
  const visibleChats = chats.filter(chat => chat.title.toLowerCase().includes(chatFilter.toLowerCase()));
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

      <div className="px-3 pb-2 pt-3">
        <button type="button" onClick={onNewChat} disabled={busy}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-paper-dim transition-colors hover:bg-white/5 hover:text-paper disabled:opacity-40">
          <SidebarIcon name="plus" className="text-leaf" /> New chat
        </button>
        <div className="mt-4 flex items-center justify-between px-2 text-[10px] text-graphite">
          <span>Chats</span><span title="Every chat can access all project files">Whole project</span>
        </div>
        {(chats.length > 5 || chatFilter) && <input aria-label="Search chats" placeholder="Search chats…" value={chatFilter}
          onChange={event => setChatFilter(event.target.value)}
          className="mt-2 w-full rounded-lg border border-rule bg-ink px-2 py-1.5 text-[11px] text-paper-dim placeholder:text-graphite" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ul aria-label="Project chats" className="space-y-1">
          {visibleChats.map(chat => <li key={chat.id} className={`group rounded-lg ${chat.id === activeChatId ? "bg-white/5" : "hover:bg-white/[0.03]"}`}>
            <div className="flex items-center">
              <button type="button" disabled={busy} onClick={() => onSelectChat(chat.id)}
                aria-label={`Open chat ${chat.title}`} aria-current={chat.id === activeChatId ? "page" : undefined}
                title={`${chat.title} · Updated ${new Date(chat.updatedAt).toLocaleString()}`}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2.5 text-left text-[12px] transition-colors disabled:opacity-50 ${chat.id === activeChatId ? "text-paper" : "text-paper-dim hover:text-paper"}`}>
                {busy && chat.id === activeChatId ? <span className="working-dot mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-leaf" /> : <SidebarIcon name="chat" className="h-3.5 w-3.5 text-graphite" />}
                <span className="min-w-0 truncate">{chat.title}</span>
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(confirmDelete === chat.id ? null : chat.id)}
                aria-label={`Delete ${chat.title}`} title="Delete chat"
                className="mr-1 rounded p-1 text-graphite opacity-0 transition-colors hover:text-pencil focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-30">
                <SidebarIcon name="close" className="h-3 w-3" />
              </button>
            </div>
            {confirmDelete === chat.id && <div className="flex items-center gap-2 px-2 pb-2 text-[10px]">
              <button type="button" disabled={busy} aria-label={`Really delete ${chat.title}?`}
                onClick={() => { setConfirmDelete(null); onDeleteChat(chat.id); }}
                className="rounded border border-pencil/40 px-2 py-1 text-pencil hover:bg-pencil/10">Delete chat</button>
              <button type="button" onClick={() => setConfirmDelete(null)} className="rounded px-2 py-1 text-graphite hover:text-paper">Cancel</button>
            </div>}
          </li>)}
        </ul>
        {!visibleChats.length && <p className="px-2 py-3 text-[11px] text-graphite">{chatFilter ? "No matching chats." : "Start a chat about this project."}</p>}
        {busy && <p className="px-2 pt-3 text-[10px] leading-relaxed text-graphite">Chat switching is available when the current operation finishes.</p>}
      </div>

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
