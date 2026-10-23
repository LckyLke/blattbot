/**
 * Pure helpers behind the History panel: labels, filters, the day grouping
 * of the timeline and which incoming commits are new since the user last
 * looked. Kept free of React and browser storage so tests can import it.
 */
import type { CommitKind, HistoryCommit, HistoryFilter, Project } from "./api.js";

export const HISTORY_FILTERS: HistoryFilter[] = ["all", "sync", "mine"];

/** Where incoming commits come from, in words. */
function remoteName(projectKind: Project["kind"]): string {
  return projectKind === "git" ? "the remote" : "Overleaf";
}

export function filterLabel(filter: HistoryFilter, projectKind: Project["kind"]): string {
  if (filter === "sync") return projectKind === "git" ? "From remote" : "From Overleaf";
  if (filter === "mine") return projectKind === "local" ? "My commits" : "Pushed by me";
  return "All";
}

export function kindLabel(kind: CommitKind, projectKind: Project["kind"]): string {
  switch (kind) {
    case "sync":
      return `From ${remoteName(projectKind)}`;
    case "approve":
      return "Pushed by you";
    case "local":
      return "Local commit";
    case "revert":
      return "Revert";
    default:
      return "Other";
  }
}

export function matchesFilter(kind: CommitKind, filter: HistoryFilter): boolean {
  if (filter === "sync") return kind === "sync";
  if (filter === "mine") return kind === "approve" || kind === "revert" || kind === "local";
  return true;
}

export interface DayGroup {
  /** Local calendar day, YYYY-MM-DD. */
  key: string;
  label: string;
  commits: HistoryCommit[];
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today", "Yesterday", or a short date (with the year when it is not this year). */
export function dayLabel(d: Date, now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * The timeline grouped by local day, in the order given (newest first).
 * A commit with an unreadable time lands in an "Unknown date" group.
 */
export function groupByDay(commits: HistoryCommit[], now = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const commit of commits) {
    const d = new Date(commit.time);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? dayKey(d) : "unknown";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: valid ? dayLabel(d, now) : "Unknown date", commits: [] };
      groups.push(group);
    }
    group.commits.push(commit);
  }
  return groups;
}

/**
 * Incoming commits newer than `seenSha` in a newest-first list. None when
 * nothing was seen yet, or when the seen commit is not in the list (then it
 * cannot be told which are new).
 */
export function newIncoming(commits: HistoryCommit[], seenSha: string | null): Set<string> {
  const fresh = new Set<string>();
  if (!seenSha) return fresh;
  const at = commits.findIndex((c) => c.sha === seenSha);
  if (at < 0) return fresh;
  for (const c of commits.slice(0, at)) if (c.kind === "sync") fresh.add(c.sha);
  return fresh;
}

/** "3 files · +12 −4" for a commit's change summary. */
export function changeSummary(commit: Pick<HistoryCommit, "files" | "additions" | "deletions">): string {
  const n = commit.files.length;
  return `${n} file${n === 1 ? "" : "s"} · +${commit.additions} −${commit.deletions}`;
}

/** Wall-clock time of a commit, e.g. "14:05". */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** localStorage key of the last commit seen in History, per project. */
export function seenKey(projectId: string): string {
  return `blattbot.historySeen.${projectId}`;
}
