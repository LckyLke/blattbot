/**
 * The Overleaf project's own settings that BlattBot mirrors: the compiler
 * (pdflatex, xelatex, lualatex, latex) and the main ("root") document. Both
 * come from the joinProject project object (`compiler`, `rootDoc_id`).
 *
 * They are read during a push (the push already joins the project, so it is
 * free) and on sync, throttled to one extra realtime join per
 * META_MAX_AGE_MS. The root document becomes Project.mainTex only while the
 * user has not picked a main file themselves (Project.mainTexChosen).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProject, projectDir, updateProject, type Project } from "../config.js";
import { broadcast } from "../events.js";
import type { OverleafClient, ProjectTree } from "./olclient.js";

export const OVERLEAF_COMPILERS = ["pdflatex", "xelatex", "lualatex", "latex"] as const;
export type OverleafCompiler = (typeof OVERLEAF_COMPILERS)[number];

export interface OverleafProjectMeta {
  compiler?: OverleafCompiler;
  /** Path of the root document, when its id is in the tree. */
  rootDocPath?: string;
}

/** How often a sync may spend a realtime join on re-reading the settings. */
export const META_MAX_AGE_MS = 30 * 60_000;

const lastChecked = new Map<string, number>();

/** The compiler and root document path of a joined project's tree. */
export function projectMetaFromTree(tree: ProjectTree): OverleafProjectMeta {
  const meta: OverleafProjectMeta = {};
  const compiler = tree.compiler?.trim().toLowerCase();
  if (compiler && (OVERLEAF_COMPILERS as readonly string[]).includes(compiler)) {
    meta.compiler = compiler as OverleafCompiler;
  }
  if (tree.rootDocId) {
    for (const entity of tree.entities.values()) {
      if (entity.type === "doc" && entity.id === tree.rootDocId) meta.rootDocPath = entity.path;
    }
  }
  return meta;
}

/**
 * Store the settings on the project: always the compiler; the root document
 * as mainTex only when it is a .tex file present locally and the user has not
 * chosen a main file. Returns the updated project when anything changed (the
 * UI is told to reload its project list then).
 */
export function applyOverleafMeta(projectId: string, meta: OverleafProjectMeta): Project | undefined {
  lastChecked.set(projectId, Date.now());
  const project = getProject(projectId);
  if (!project) return undefined;
  const patch: Partial<Project> = {};
  if (meta.compiler && project.overleafCompiler !== meta.compiler) patch.overleafCompiler = meta.compiler;
  const root = meta.rootDocPath;
  if (
    root &&
    /\.tex$/i.test(root) &&
    project.mainTexChosen !== true &&
    project.mainTex !== root &&
    existsSync(join(projectDir(projectId), root))
  ) {
    patch.mainTex = root;
  }
  if (Object.keys(patch).length === 0) return undefined;
  const updated = updateProject(projectId, patch);
  broadcast(projectId, { type: "project_updated", fields: Object.keys(patch) });
  return updated;
}

/** Whether a sync should re-read the settings now. */
export function overleafMetaDue(projectId: string, now = Date.now()): boolean {
  const at = lastChecked.get(projectId);
  return at === undefined || now - at >= META_MAX_AGE_MS;
}

/**
 * Re-read the settings over a realtime join when due (or forced). `run`
 * supplies a client (with the caller's session-refresh handling). Returns a
 * warning line on failure, null otherwise — never throws: the settings are a
 * convenience next to the file sync.
 */
export async function refreshOverleafMeta(
  project: Project,
  run: <T>(fn: (client: OverleafClient) => Promise<T>) => Promise<T>,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  if (project.kind !== "overleaf" || !project.overleafProjectId) return null;
  if (!opts.force && !overleafMetaDue(project.id)) return null;
  // Counted as checked up front, so a failing instance is not retried on every turn.
  lastChecked.set(project.id, Date.now());
  try {
    const tree = await run((client) => client.joinProjectTree(project.overleafProjectId!));
    applyOverleafMeta(project.id, projectMetaFromTree(tree));
    return null;
  } catch (err: any) {
    return `could not read the Overleaf project settings (compiler, main document): ${err?.message ?? err}`;
  }
}

/** Test hook: forget when each project was last checked. */
export function resetOverleafMetaChecks(): void {
  lastChecked.clear();
}
