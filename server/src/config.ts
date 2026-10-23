import { chmodSync, mkdirSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "./jsonfile.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DATA_DIR =
  process.env.BLATTBOT_DATA_DIR ?? join(homedir(), ".local", "share", "blattbot");
export const PROJECTS_DIR = join(DATA_DIR, "projects");
export const BUILDS_DIR = join(DATA_DIR, "builds");
export const BIN_DIR = join(DATA_DIR, "bin");

const REGISTRY_PATH = join(DATA_DIR, "projects.json");

/** Cumulative agent usage of a project — bumped by chats.ts at every turn end.
 *  Cost is only known on the Claude backend; turns count regardless. */
export interface ProjectStats {
  totalCostUsd: number;
  totalTurns: number;
}

/** Per-project settings — edited via the /api/projects/:id/settings endpoints.
 *  updateProject merges top-level keys only, so writers always persist the
 *  whole settings object, never a partial one. */
export interface ProjectSettings {
  /** Writing style / instructions for this project, appended to the system
   *  prompt after the mode block (capped at MAX_STYLE_APPEND in agent.ts). */
  styleAppend?: string;
  /** Model override for this project — takes precedence over the global setting. */
  model?: string;
  /** The harness this override belongs to; older projects may omit it. */
  modelBackend?: "codex" | "claude" | "openai";
  /** Mode preselected for new chats in this project (a client-side concern). */
  defaultMode?: string;
  /** Overleaf projects: push in-place doc edits as tracked changes (experimental, default off). */
  trackChanges?: boolean;
  /** Overleaf projects: label each push in Overleaf's project history (default off). */
  labelPushes?: boolean;
}

/** The blattbot.md version the user confirmed for the agent (see shared-instructions.ts). */
export interface ConfirmedSharedInstructions {
  sha256: string;
  content: string;
  confirmedAt: string;
}

export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  /** "git" = real git remote; "overleaf" = cookie-synced Overleaf web project;
   *  "local" = standalone local repo (can be published to Overleaf later). */
  kind?: "git" | "overleaf" | "local";
  /** Overleaf git token (or any git password). Stored 0600, never sent to the UI. */
  token?: string;
  /** Cookie-mode connection: instance origin + remote project id. */
  overleafBaseUrl?: string;
  overleafProjectId?: string;
  /** The account whose session this project syncs through (see accounts.ts). */
  accountId?: string;
  /** Legacy per-project cookie — migrated into accounts.json on startup. */
  cookie?: string;
  /** Relative path of the main .tex file, auto-detected on clone. */
  mainTex?: string;
  /** The user picked mainTex in the project settings — detection and Overleaf's root document must not replace it. */
  mainTexChosen?: boolean;
  /** Agent SDK session id, for conversation continuity across turns.
   *  Legacy: sessions now live per chat (chats.ts); kept in sync for rollback. */
  sessionId?: string;
  /** The chat new messages go to — see chats.ts. */
  activeChatId?: string;
  /** Linked external read-only context paths (code, data, literature) — see context.ts. */
  contextPaths?: string[];
  /** Per-project settings (style append, model override, default mode). */
  settings?: ProjectSettings;
  /** Cumulative agent cost/turn totals — see chats.ts (updated at turn end). */
  stats?: ProjectStats;
  /** Overleaf projects: when the last full sync (snapshot download) finished. */
  lastSyncAt?: string;
  /**
   * Overleaf projects: Overleaf's project `lastUpdated` as of the last
   * successful sync or push. A newer value in the project list means a
   * co-author (or the user, on Overleaf) changed something since.
   */
  remoteLastUpdated?: string;
  /**
   * Overleaf projects: Overleaf's project-history version as of the last
   * successful sync or push. It moves with every edit, so a newer one means
   * someone changed the project on Overleaf since.
   */
  remoteVersion?: number;
  /** The compiler set in the Overleaf project (read on sync and push; see overleaf/metadata.ts). */
  overleafCompiler?: "pdflatex" | "xelatex" | "lualatex" | "latex";
  /** The blattbot.md version the user confirmed (see shared-instructions.ts). */
  sharedInstructions?: ConfirmedSharedInstructions;
  createdAt: string;
}

export function ensureDirs(): void {
  for (const d of [DATA_DIR, PROJECTS_DIR, BUILDS_DIR, BIN_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  try {
    chmodSync(DATA_DIR, 0o700);
  } catch {
    /* best effort */
  }
}

function loadRegistry(): Project[] {
  return readJsonFile<Project[]>(REGISTRY_PATH, []);
}

function saveRegistry(projects: Project[]): void {
  ensureDirs();
  writeJsonFile(REGISTRY_PATH, projects);
}

export function listProjects(): Project[] {
  return loadRegistry();
}

export function getProject(id: string): Project | undefined {
  return loadRegistry().find((p) => p.id === id);
}

export function addProject(p: Omit<Project, "id" | "createdAt">): Project {
  const projects = loadRegistry();
  const slug =
    p.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "project";
  const id = `${slug}-${randomBytes(3).toString("hex")}`;
  const project: Project = { ...p, id, createdAt: new Date().toISOString() };
  projects.push(project);
  saveRegistry(projects);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>): Project | undefined {
  const projects = loadRegistry();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return undefined;
  projects[idx] = { ...projects[idx], ...patch, id };
  saveRegistry(projects);
  return projects[idx];
}

export function removeProject(id: string): boolean {
  const projects = loadRegistry();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  saveRegistry(next);
  return true;
}

export function projectDir(id: string): string {
  return join(PROJECTS_DIR, id);
}

export function buildDir(id: string): string {
  return join(BUILDS_DIR, id);
}

/** Public view of a project — everything except the secrets. */
export function publicProject(
  p: Project,
): Omit<Project, "token" | "cookie"> & { hasToken: boolean; kind: "git" | "overleaf" | "local" } {
  const { token, cookie, ...rest } = p;
  return { ...rest, kind: p.kind ?? "git", hasToken: Boolean(token ?? cookie) };
}
