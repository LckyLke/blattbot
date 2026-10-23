/**
 * A project's status at a glance (dashboard cards, the sidebar switcher):
 * kind, a running agent turn, pending changes and the last sync — plus the
 * link to the project on Overleaf. Pure, so the wording is testable.
 */
import type { Project } from "./api.js";

export const KIND_LABEL: Record<Project["kind"], string> = {
  overleaf: "overleaf",
  git: "git",
  local: "local",
};

/** The project in the Overleaf editor, for Overleaf-kind projects only. */
export function overleafProjectUrl(p: Pick<Project, "kind" | "overleafBaseUrl" | "overleafProjectId">): string | null {
  if (p.kind !== "overleaf" || !p.overleafBaseUrl || !p.overleafProjectId) return null;
  let base: URL;
  try {
    base = new URL(p.overleafBaseUrl);
  } catch {
    return null;
  }
  // Only web origins: the link opens in a new tab.
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/project/${encodeURIComponent(p.overleafProjectId)}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or a date. */
export function timeAgo(iso?: string, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export interface ProjectStatus {
  working: boolean;
  /** Files with pending (unapproved) changes. */
  pending: number;
  /** "synced 5 min ago", when the server reports a last sync. */
  synced: string | null;
}

/**
 * The status of a listed project. The open project passes its live values
 * (the websocket-driven turn state and the current diff), which are fresher
 * than the polled list.
 */
export function projectStatus(
  p: Pick<Project, "turnActive" | "pendingFiles" | "lastSyncAt">,
  live?: { working: boolean; pending: number },
  now = Date.now(),
): ProjectStatus {
  const synced = timeAgo(p.lastSyncAt, now);
  return {
    working: live ? live.working : Boolean(p.turnActive),
    pending: live ? live.pending : Math.max(0, p.pendingFiles ?? 0),
    synced: synced ? `synced ${synced}` : null,
  };
}

export function pendingLabel(n: number): string {
  return n === 1 ? "1 pending file" : `${n} pending files`;
}

/** One line for places that only take text (the switcher's <option>s). */
export function statusSuffix(s: ProjectStatus): string {
  const parts: string[] = [];
  if (s.working) parts.push("agent working");
  if (s.pending > 0) parts.push(pendingLabel(s.pending));
  return parts.length ? ` — ${parts.join(" · ")}` : "";
}
