// Project list, create (local / Overleaf / git), update, delete, detail and
// per-project settings.
import type { FastifyInstance } from "fastify";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listResearchJobs } from "../research/jobs.js";
import {
  addProject,
  buildDir,
  getProject,
  listProjects,
  projectDir,
  publicProject,
  removeProject,
  updateProject,
  type Project,
  type ProjectSettings,
} from "../config.js";
import * as git from "../git.js";
import { findMainTex, listFiles } from "../latex.js";
import { deletePaperData } from "../papers.js";
import {
  activeBackendId,
  deleteSessionData,
  isTurnActive,
  projectModelOverride,
  resolveBackendModel,
  validateProjectSettingsPatch,
} from "../agent.js";
import { pendingQuestion } from "../questions.js";
import { deleteAllChats } from "../chats.js";
import { deleteResearchData } from "../research/store.js";
import { withProjectLock } from "../project-lock.js";
import { repositoriesDir } from "../repositories.js";
import { OverleafClient, parseProjectUrl } from "../overleaf/olclient.js";
import { applySnapshot, unpackZip } from "../overleaf/olsync.js";
import { getAccount, updateAccount, upsertAccount } from "../accounts.js";
import { loadSettings } from "../settings.js";
import { contextUploadsDir } from "../context.js";
import { deleteChatUploads } from "../chatimages.js";
import { compilePublic, lastCompile } from "../app-state.js";
import { normalizeCookie } from "../http-helpers.js";
import { FileOpError, checkMainTex } from "../project-files.js";

/** Escape LaTeX-special characters so a project name is safe inside \title{…}. */
function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function localTemplate(name: string): { path: string; content: string }[] {
  return [
    {
      path: "main.tex",
      content: `\\documentclass{article}

\\title{${texEscape(name)}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}

Start writing here.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
    },
    {
      path: "references.bib",
      content: "% BibTeX entries live here — add them by hand or ask BlattBot to cite papers.\n",
    },
  ];
}

/** The stored settings object plus the model a turn on this project actually
 *  runs under the ACTIVE backend (override → global, aliases resolved for
 *  claude, verbatim for openai). */
function projectSettingsView(project: Project) {
  const settings = loadSettings();
  return {
    ...(project.settings ?? {}),
    model: projectModelOverride(project, settings),
    resolvedModel: resolveBackendModel(project, settings),
  };
}

export function registerProjectRoutes(app: FastifyInstance): void {
  // Each entry carries its live status for the dashboard and the sidebar
  // switcher: a running agent turn and how many files have pending changes.
  app.get("/api/projects", async () =>
    Promise.all(
      listProjects().map(async (p) => ({
        ...publicProject(p),
        turnActive: isTurnActive(p.id),
        pendingFiles: await git.pendingFileCount(projectDir(p.id)).catch(() => 0),
      })),
    ),
  );

  app.post<{
    Body: {
      name?: string;
      gitUrl?: string;
      url?: string;
      token?: string;
      cookie?: string;
      accountId?: string;
      projectId?: string;
      local?: boolean;
    };
  }>(
    "/api/projects",
    async (req, reply) => {
      const body = req.body ?? ({} as any);
      const url = (body.url ?? body.gitUrl ?? "").trim();

      // ---- Local mode: standalone project, publishable to Overleaf later ----
      if (body.local) {
        const name = body.name?.trim();
        if (!name) return reply.code(400).send({ error: "name is required" });
        const project = addProject({ name, gitUrl: "local", kind: "local" });
        try {
          const dir = projectDir(project.id);
          await git.initRepo(dir);
          for (const f of localTemplate(name)) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, f.path), f.content);
          }
          await git.commitAll(dir, "New project");
        } catch (err: any) {
          removeProject(project.id);
          rmSync(projectDir(project.id), { recursive: true, force: true });
          return reply.code(422).send({ error: `Project setup failed: ${err.message}` });
        }
        updateProject(project.id, { mainTex: "main.tex" });
        return publicProject(getProject(project.id)!);
      }

      // ---- Overleaf mode: via a stored account, or legacy pasted link + cookie ----
      let olRef = parseProjectUrl(url);
      let accountId: string | undefined;
      let cookie: string | undefined;
      if (body.accountId && body.projectId) {
        const account = getAccount(body.accountId);
        if (!account) return reply.code(404).send({ error: "unknown account" });
        if (!/^[0-9a-fA-F]{24}$/.test(body.projectId)) {
          return reply.code(400).send({ error: "invalid Overleaf project id" });
        }
        olRef = { baseUrl: account.baseUrl, projectId: body.projectId };
        accountId = account.id;
        cookie = account.cookie;
      } else if (olRef) {
        if (!body.cookie?.trim()) {
          return reply.code(400).send({
            error:
              "This looks like an Overleaf project link — paste your session cookie too (DevTools → Application → Cookies).",
          });
        }
        cookie = normalizeCookie(body.cookie);
        // Fold the pasted session into a persistent account.
        const email = await new OverleafClient(olRef.baseUrl, cookie).userEmail();
        accountId = upsertAccount({ baseUrl: olRef.baseUrl, cookie, email }).id;
      } else if (!url) {
        return reply.code(400).send({ error: "url is required" });
      }

      if (olRef && cookie) {
        const client = new OverleafClient(olRef.baseUrl, cookie);
        let snapshot: Map<string, Buffer>;
        try {
          snapshot = unpackZip(await client.downloadZip(olRef.projectId));
        } catch (err: any) {
          return reply.code(422).send({ error: `Overleaf sync failed: ${err.message}` });
        }
        const name =
          body.name?.trim() || (await client.projectName(olRef.projectId)) || `Overleaf ${olRef.projectId.slice(0, 6)}`;
        const project = addProject({
          name,
          gitUrl: `${olRef.baseUrl}/project/${olRef.projectId}`,
          kind: "overleaf",
          overleafBaseUrl: olRef.baseUrl,
          overleafProjectId: olRef.projectId,
          accountId,
        });
        try {
          const dir = projectDir(project.id);
          await git.initRepo(dir);
          await applySnapshot(dir, snapshot, "Initial sync from Overleaf");
        } catch (err: any) {
          removeProject(project.id);
          rmSync(projectDir(project.id), { recursive: true, force: true });
          return reply.code(422).send({ error: `Local mirror setup failed: ${err.message}` });
        }
        const mainTex = findMainTex(projectDir(project.id));
        if (mainTex) updateProject(project.id, { mainTex });
        return publicProject(getProject(project.id)!);
      }

      // ---- git mode (Overleaf git bridge, GitHub, local path, …) ----
      const name = body.name?.trim() || url.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || "project";
      const project = addProject({ name, gitUrl: url, kind: "git", token: body.token });
      try {
        await git.clone(url, body.token, projectDir(project.id));
      } catch (err: any) {
        removeProject(project.id);
        rmSync(projectDir(project.id), { recursive: true, force: true });
        return reply.code(422).send({ error: `Clone failed: ${err.message}` });
      }
      const mainTex = findMainTex(projectDir(project.id));
      if (mainTex) updateProject(project.id, { mainTex });
      return publicProject(getProject(project.id)!);
    },
  );

  app.patch<{ Params: { id: string }; Body: { cookie?: string; mainTex?: unknown } }>("/api/projects/:id", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    // The user picks the main file: detection (and Overleaf metadata) must
    // not replace it afterwards — mainTexChosen records that.
    if (req.body?.mainTex !== undefined) {
      let mainTex: string;
      try {
        mainTex = checkMainTex(projectDir(project.id), req.body.mainTex);
      } catch (err) {
        if (err instanceof FileOpError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
      const updated = updateProject(project.id, { mainTex, mainTexChosen: true })!;
      return { ok: true, project: publicProject(updated) };
    }
    if (req.body?.cookie?.trim()) {
      const cookie = normalizeCookie(req.body.cookie);
      // Sessions live on accounts now; fall back to the legacy per-project field.
      if (project.accountId && getAccount(project.accountId)) {
        updateAccount(project.accountId, {
          cookie,
          status: "connected",
          lastVerifiedAt: new Date().toISOString(),
        });
      } else {
        updateProject(project.id, { cookie });
      }
      return { ok: true };
    }
    return reply.code(400).send({ error: "nothing to update" });
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = req.params;
    if (!getProject(id)) return reply.code(404).send({ error: "unknown project" });
    // A running turn or research job would recreate the folders it writes to.
    if (isTurnActive(id)) return reply.code(409).send({ error: "Stop the agent turn before removing this project." });
    if (listResearchJobs(id).some((j) => ["queued", "running"].includes(j.state))) {
      return reply.code(409).send({ error: "Pause or cancel this project's research tasks before removing it." });
    }
    await withProjectLock(id, async () => {
      removeProject(id);
      rmSync(projectDir(id), { recursive: true, force: true });
      rmSync(buildDir(id), { recursive: true, force: true });
      rmSync(contextUploadsDir(id), { recursive: true, force: true });
      rmSync(repositoriesDir(id), { recursive: true, force: true });
      // The chat transcripts that referenced them are going too.
      deleteChatUploads(id);
      // Conversations (and what the backends stored for them), research,
      // paper records/PDFs and audits belong to the project too.
      for (const sessionId of deleteAllChats(id)) deleteSessionData(sessionId);
      deleteResearchData(id);
      deletePaperData(id);
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const dir = projectDir(project.id);
    const compile = lastCompile.get(project.id);
    return {
      ...publicProject(project),
      files: listFiles(dir),
      turnActive: isTurnActive(project.id),
      // A reload mid-turn restores the actionable question card from this.
      pendingQuestion: pendingQuestion(project.id) ?? null,
      hasChanges: await git.hasChanges(dir).catch(() => false),
      lastCompile: compile ? compilePublic(compile) : null,
    };
  });

  // ---- Per-project settings ---------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/projects/:id/settings", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return projectSettingsView(project);
  });

  app.put<{
    Params: { id: string };
    Body: { styleAppend?: string; model?: string; defaultMode?: string; trackChanges?: boolean };
  }>("/api/projects/:id/settings", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    let patch: Partial<ProjectSettings>;
    try {
      patch = validateProjectSettingsPatch(req.body);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    // updateProject merges top-level keys only — always write the WHOLE settings
    // object. An empty string clears its field (kept out of projects.json).
    const merged: ProjectSettings = { ...(project.settings ?? {}), ...patch };
    if (patch.model !== undefined) {
      if (patch.model.trim()) merged.modelBackend = activeBackendId(loadSettings());
      else delete merged.modelBackend;
    }
    for (const key of Object.keys(merged) as (keyof ProjectSettings)[]) {
      const value = merged[key];
      if (typeof value === "string" ? !value.trim() : value !== true) delete merged[key];
    }
    const updated = updateProject(project.id, { settings: merged })!;
    return projectSettingsView(updated);
  });
}
