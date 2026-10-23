import type { Project } from "../api";
import { KIND_LABEL, overleafProjectUrl, pendingLabel, type ProjectStatus } from "../project-status";

/** The project kind as a small badge (local in gold, git and overleaf quiet). */
export function KindBadge({ kind }: { kind: Project["kind"] }) {
  return (
    <span
      title={kind === "overleaf" ? "Synced with an Overleaf project" : kind === "git" ? "A git repository" : "Local only — no remote"}
      className={`rounded-sm border px-1 font-mono text-[10.5px] uppercase tracking-wide ${
        kind === "local" ? "border-gold/40 text-gold" : "border-rule text-graphite"
      }`}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

/** Running turn, pending changes and last sync, as quiet inline badges. */
export function StatusBadges({ status, kind }: { status: ProjectStatus; kind?: Project["kind"] }) {
  if (!kind && !status.working && status.pending === 0 && !status.synced) return null;
  return (
    <span data-project-status className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {kind && <KindBadge kind={kind} />}
      {status.working && (
        <span className="flex items-center gap-1 text-[10.5px] text-leaf" title="An agent turn is running in this project">
          <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-leaf" />
          agent working
        </span>
      )}
      {status.pending > 0 && (
        <span
          className="rounded-sm border border-gold/40 px-1 font-mono text-[10.5px] text-gold"
          title={`${pendingLabel(status.pending)} — review them in Proof`}
        >
          {status.pending} pending
        </span>
      )}
      {status.synced && <span className="font-mono text-[10.5px] text-graphite">{status.synced}</span>}
    </span>
  );
}

/** "Open in Overleaf ↗" — a new tab on the Overleaf project; nothing for other kinds. */
export function OpenInOverleaf({
  project,
  label = "Open in Overleaf",
  className = "",
}: {
  project: Pick<Project, "name" | "kind" | "overleafBaseUrl" | "overleafProjectId">;
  label?: string;
  className?: string;
}) {
  const url = overleafProjectUrl(project);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${project.name} in Overleaf`}
      title="Open this project in the Overleaf editor (new tab)"
      className={`whitespace-nowrap text-[11.5px] text-graphite underline decoration-rule underline-offset-2 transition-colors hover:text-leaf hover:decoration-leaf ${className}`}
    >
      {label} ↗
    </a>
  );
}
