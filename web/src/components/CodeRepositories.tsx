import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import LocalRepositoryPicker from "./LocalRepositoryPicker";
import SidebarIcon from "./SidebarIcon";

interface Repository {
  id: string; source: string; name: string; ref: string; commit: string;
  attachedAt: string; checkedAt: string; localChangesExcluded: boolean;
}
interface CodeInput {
  repositoryId: string; commit: string; path: string; oid: string; role: string;
  repositorySource: string; repositoryRef: string;
  startLine: number; endLine: number; content: string;
}
interface Assessment {
  id: string; at: string; stale: boolean; verdict: string; explanation: string;
  claim: { file: string; quote: string; line: number; kind: string };
  inputs: CodeInput[]; evidence: { index: number; quote: string; line: number }[];
  limitations: string[]; nextChecks: string[];
  assessor: { backend: string; configuredModel: string; protocol: string };
}
const field = "w-full min-w-0 rounded border border-rule bg-ink-2 px-2 py-1.5 text-xs text-paper";
const button = "rounded border border-rule px-2 py-1 text-xs text-paper-dim hover:border-leaf disabled:opacity-40";
const changed = () => window.dispatchEvent(new Event("blattbot-repositories-changed"));

export function RepositoryManager({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<"remote" | "local">("remote");
  const [pickerOpen, setPickerOpen] = useState(false);
  const active = useRef(projectId);
  active.current = projectId;
  useEffect(() => {
    let alive = true;
    const load = () => api.research<Repository[]>(projectId, "/repositories").then(r => { if (alive) setRepos(r); }).catch(e => { if (alive) setError(e.message); });
    setRepos([]); setSource(""); setRef(""); setError(""); setBusy(""); setPickerOpen(false);
    void load();
    window.addEventListener("blattbot-repositories-changed", load);
    return () => { alive = false; window.removeEventListener("blattbot-repositories-changed", load); };
  }, [projectId]);
  async function mutate(path: string, body: unknown, label: string) {
    if (busy) return;
    setBusy(label); setError("");
    try {
      await api.research(projectId, path, body);
      if (active.current !== projectId) return;
      if (path === "/repositories") { setSource(""); setRef(""); setOpen(false); }
      changed();
    } catch (e) { if (active.current === projectId) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active.current === projectId) setBusy(""); }
  }
  const quietButton = "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[10.5px] text-graphite transition-colors hover:bg-white/5 hover:text-paper-dim disabled:opacity-40";
  return <div className={compact ? "mx-2 my-1 space-y-2 text-xs" : "space-y-3"}>
    <div className="flex items-center justify-between gap-2">
      <span className={compact ? "pl-1 text-[10.5px] text-graphite" : "font-medium text-paper-dim"}>Git repositories {repos.length > 0 && <span className={compact ? "ml-1 text-graphite/70" : ""}>{repos.length}</span>}</span>
      <button className={compact ? quietButton : button} aria-label={open ? "Close" : "Add repository"} aria-expanded={open} onClick={() => setOpen(!open)}>
        {compact && <SidebarIcon name={open ? "close" : "plus"} className="h-3 w-3" />}{open ? "Close" : compact ? "Add" : "Add repository"}
      </button>
    </div>
    {open && <form className="space-y-2" onSubmit={e => { e.preventDefault(); void mutate("/repositories", { source, ref: ref || "HEAD" }, "Fetching repository…"); }}>
      <div className="flex gap-2" role="group" aria-label="Repository source">
        {(["remote", "local"] as const).map(kind => <button key={kind} type="button" aria-pressed={sourceKind === kind}
          className={`${button} ${sourceKind === kind ? "border-leaf text-leaf" : ""}`}
          onClick={() => { if (kind !== sourceKind) { setSourceKind(kind); setSource(""); setRef(""); setError(""); } }}>
          {kind === "remote" ? "Repository URL" : "Local folder"}
        </button>)}
      </div>
      {sourceKind === "remote" ? <>
        <label className="block">Repository URL<input className={field} value={source} onChange={e => setSource(e.target.value)} placeholder="https://github.com/owner/repository.git" required /></label>
        <p className="text-[11px] text-graphite">Private repositories use your existing Git credentials or SSH setup.</p>
      </> : <>
        <button type="button" className={`${button} w-full py-2`} onClick={() => setPickerOpen(true)}>{source ? "Change folder…" : "Browse folders…"}</button>
        {source && <p className="break-all text-[11px] text-paper-dim">{source}</p>}
        {!source && <p className="text-[11px] text-graphite">Choose a repository on this computer. You can paste a path in the folder browser.</p>}
      </>}
      <label className="block">Branch, tag or commit<input className={field} value={ref} onChange={e => setRef(e.target.value)} placeholder={sourceKind === "local" ? "Current checkout (HEAD)" : "Default branch (HEAD)"} /></label>
      <p className="text-[11px] text-graphite">Only committed files are included; local edits are excluded.</p>
      <button className={button} disabled={!!busy || !source.trim()}>Attach snapshot</button>
    </form>}
    {pickerOpen && <LocalRepositoryPicker projectId={projectId} initialPath={source}
      onClose={() => setPickerOpen(false)} onSelect={repository => {
        setSource(repository.path); setRef(repository.branch ?? repository.commit ?? "HEAD"); setError(""); setPickerOpen(false);
      }} />}
    {busy && <p role="status" className="text-leaf">{busy}</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {repos.map(repo => <div key={repo.id} className={compact ? "rounded-lg bg-ink/60 p-2.5" : "rounded border border-rule p-2"}>
      <div className="flex items-center gap-2">
        {compact && <SidebarIcon name="branch" className="h-3.5 w-3.5 text-leaf/80" />}
        <span className="min-w-0 truncate font-medium text-paper" title={repo.name}>{repo.name}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px] text-graphite" title={repo.source}>
        <span className="truncate" title={repo.ref}>{repo.ref}</span><span className="opacity-50">·</span><code className="shrink-0 text-[9.5px]" title={repo.commit}>{repo.commit.slice(0, compact ? 8 : 12)}</code>
      </div>
      {!compact && <p className="break-all text-xs text-graphite">{repo.source}<br />Checked {new Date(repo.checkedAt).toLocaleString()}{repo.localChangesExcluded && " · Local edits excluded"}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={compact ? quietButton : button} aria-label="Refresh revision" disabled={!!busy} title="Fetch the selected revision again; changed snapshots make old assessments stale" onClick={() => void mutate("/repositories/refresh", { repositoryId: repo.id }, `Refreshing ${repo.name}…`)}>
          {compact && <SidebarIcon name="sync" className="h-3 w-3" />}{compact ? "Refresh" : "Refresh revision"}
        </button>
        <button className={compact ? `${quietButton} ml-auto hover:text-pencil` : button} aria-label="Remove" title={`Remove ${repo.name}`} disabled={!!busy} onClick={() => void mutate("/repositories/remove", { repositoryId: repo.id }, `Removing ${repo.name}…`)}>
          {compact ? <SidebarIcon name="close" className="h-3.5 w-3.5" /> : "Remove"}
        </button>
      </div>
    </div>)}
    {!compact && <p className="text-xs text-graphite">Snapshots stay pinned until you refresh. Ask in chat what the attached branch introduced compared with a base branch, such as main, to inspect its commits and changes. Submodule contents and Git LFS datasets/models are excluded. Code is read as evidence; attaching it does not run it.</p>}
  </div>;
}

const labels: Record<string, string> = { supported: "Implementation agrees", contradicted: "Contradiction found", insufficient_evidence: "Insufficient evidence", requires_execution: "Execution required" };
export function CodeChecks({ projectId, stamp, busy, onAudit, onJump }: {
  projectId: string; stamp: number; busy: boolean; onAudit?: (focus: string) => void;
  onJump: (file: string, line: number) => void;
}) {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState("");
  const [repoCount, setRepoCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([api.research<Assessment[]>(projectId, "/code-evidence"), api.research<Repository[]>(projectId, "/repositories")])
      .then(([records, repos]) => { if (alive) { setAssessments(records); setRepoCount(repos.length); setError(""); } })
      .catch(e => { if (alive) setError(e.message); });
    void load();
    window.addEventListener("blattbot-repositories-changed", load);
    return () => { alive = false; window.removeEventListener("blattbot-repositories-changed", load); };
  }, [projectId, stamp]);
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "blattbot-code-evidence-v1", exportedAt: new Date().toISOString(), assessments }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "code-evidence.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="research-card">
    <h3>Verify claims against code</h3>
    <p>Trace manuscript claims through the actual implementation, configuration and evaluation code. Every saved assessment identifies its Git commit and exact source passages.</p>
    <RepositoryManager projectId={projectId} />
    <label>What should the agent check?<textarea value={focus} onChange={e => setFocus(e.target.value)} rows={2} placeholder="Optional: focus on the loss function, training defaults, data splits, or evaluation metrics" /></label>
    {onAudit && <button className="research-primary" disabled={busy || repoCount === 0} onClick={() => onAudit(focus)}>Check manuscript against code</button>}
    <p className="research-meta">Runs in read-only chat using your selected agent and may incur model usage costs. The agent explores the repository and saves individual claim assessments here. Experimental reproduction and mathematical proofs need additional evidence.</p>
    {error && <p role="alert">{error}</p>}
    <div className="flex items-center justify-between gap-2"><h4>Saved claim assessments · {assessments.length}</h4>{assessments.length > 0 && <button className={button} onClick={download}>Export evidence</button>}</div>
    {!assessments.length && <p className="research-empty">No code claims assessed yet. An unchecked claim has no verdict.</p>}
    {assessments.map(a => <details key={a.id} className="research-meta rounded border border-rule p-3">
      <summary><span className={`research-badge ${a.stale ? "research-stale" : ""}`}>{a.stale ? "Changed · check again" : labels[a.verdict]}</span> {a.claim.quote.slice(0, 130)}{a.claim.quote.length > 130 ? "…" : ""}</summary>
      <button className="research-link" onClick={() => onJump(a.claim.file, a.claim.line)}>{a.claim.file}:{a.claim.line}</button>
      <blockquote>{a.claim.quote}</blockquote>
      <p>{a.explanation}</p>
      <p>{new Date(a.at).toLocaleString()} · {a.claim.kind} claim · {a.inputs.length} source excerpts{a.stale && ` · Previous verdict: ${labels[a.verdict]}`}</p>
      <p>Assessor: {a.assessor.backend} / {a.assessor.configuredModel} · {a.assessor.protocol}</p>
      {a.evidence.map((location, i) => {
        const input = a.inputs[location.index];
        return <div key={i}><p className="break-all"><strong>{input.path}:{location.line}</strong> · {input.role} · <code title={input.commit}>{input.commit.slice(0, 12)}</code></p><pre className="whitespace-pre-wrap">{location.quote}</pre></div>;
      })}
      <h4>Limits and missing evidence</h4><ul>{a.limitations.map((line, i) => <li key={i}>{line}</li>)}</ul>
      {!!a.nextChecks.length && <><h4>Follow-up checks</h4><ul>{a.nextChecks.map((line, i) => <li key={i}>{line}</li>)}</ul></>}
      <details><summary>All inspected excerpts and full Git identities</summary>{a.inputs.map((input, i) => <div key={i}>
        <p className="break-all">{input.repositorySource} ({input.repositoryRef})<br />{input.path}:{input.startLine}–{input.endLine}<br />Commit: {input.commit}<br />Blob: {input.oid}</p><pre className="whitespace-pre-wrap">{input.content}</pre>
      </div>)}</details>
    </details>)}
  </section>;
}
