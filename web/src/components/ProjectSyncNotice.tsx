import { useEffect, useRef } from "react";
import type { SyncIssue } from "../useProjectSync";

interface Props {
  projectName: string;
  issue?: SyncIssue | null;
  popup?: boolean;
  syncing?: boolean;
  reconnecting?: boolean;
  canReconnect: boolean;
  onDismiss: () => void;
  onSync: () => void;
  onReconnect: (mode: "import" | "browser") => void;
  onReview: () => void;
  onSettings: () => void;
}

export default function ProjectSyncNotice(props: Props) {
  const { issue, popup, syncing, reconnecting, onDismiss } = props;
  const modal = useRef<HTMLDialogElement>(null);
  const open = Boolean(popup && issue);
  useEffect(() => {
    const element = modal.current;
    if (!element || !open) return;
    element.showModal();
    return () => element.close();
  }, [open]);
  if (!issue) return syncing ? <div role="status" className="shrink-0 border-b border-rule bg-ink-2 px-4 py-2 text-xs text-paper-dim">Syncing project with remote…</div> : null;
  const button = "rounded border border-rule px-3 py-1.5 text-xs text-paper hover:border-graphite disabled:opacity-50";
  const actions = <>
    {issue.kind === "session" && (props.canReconnect ? <>
      <button className={button} disabled={syncing || reconnecting} onClick={() => props.onReconnect("import")}>Reconnect from browser session</button>
      <button className={button} disabled={syncing || reconnecting} onClick={() => props.onReconnect("browser")}>Log in via browser</button>
    </> : <button className={button} onClick={() => { onDismiss(); props.onSettings(); }}>Connection settings</button>)}
    {issue.kind === "conflict" && <button className={button} onClick={() => { onDismiss(); props.onReview(); }}>Review changes</button>}
    <button className={button} disabled={syncing || reconnecting} onClick={props.onSync}>{syncing ? "Syncing…" : reconnecting ? "Reconnecting…" : "Retry sync"}</button>
  </>;
  const message = <>
    <p>{issue.message}</p>
    {issue.paths && <ul className="mt-2 max-h-40 list-inside list-disc overflow-auto font-mono text-xs">{issue.paths.map(path => <li key={path}>{path}</li>)}</ul>}
    {issue.kind === "session" && <p className="mt-2">Reconnect to receive and send Overleaf changes. Your local work is still available.</p>}
  </>;
  return <>
    <section role="alert" aria-label="Project sync warning" className="max-h-48 shrink-0 overflow-auto border-b border-pencil/40 bg-pencil/10 px-4 py-3">
      <strong className="text-sm text-pencil">{issue.title}</strong>
      <div className="mt-1 text-xs text-paper-dim">{message}</div>
      <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
    </section>
    <dialog ref={modal} onCancel={onDismiss} aria-labelledby="project-sync-title" className="m-auto w-[480px] max-w-[calc(100%-2rem)] rounded-2xl border border-rule bg-ink-2 p-5 text-paper shadow-2xl backdrop:bg-ink/80">
      <h2 id="project-sync-title" className="text-lg font-semibold">{issue.title}</h2>
      <p className="mt-1 text-xs text-graphite">{props.projectName}</p>
      <div className="mt-3 text-sm text-paper-dim">{message}</div>
      <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
      <div className="mt-4 flex justify-end"><button autoFocus className={button} onClick={onDismiss}>Keep working locally</button></div>
    </dialog>
  </>;
}
