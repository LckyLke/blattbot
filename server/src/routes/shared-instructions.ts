// Shared project instructions (blattbot.md): show the file and which version
// the agent uses, confirm a version (pinned by SHA-256), and create the file
// from the local project instructions as a normal pending change.
import type { FastifyInstance } from "fastify";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProject, projectDir, updateProject } from "../config.js";
import * as git from "../git.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";
import {
  SHARED_INSTRUCTIONS_FILE,
  SharedInstructionsError,
  confirmSharedInstructions,
  sha256,
  sharedInstructionsState,
  sharedInstructionsTemplate,
} from "../shared-instructions.js";

export function registerSharedInstructionsRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/shared-instructions", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    return sharedInstructionsState(project);
  });

  app.post<{ Params: { id: string }; Body: { sha256?: unknown } }>(
    "/api/projects/:id/shared-instructions/confirm",
    async (req, reply) => {
      if (!getProject(req.params.id)) return reply.code(404).send({ error: "unknown project" });
      const expected = req.body?.sha256;
      if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
        return reply.code(400).send({ error: "sha256 of the reviewed version is required" });
      }
      try {
        return confirmSharedInstructions(req.params.id, expected);
      } catch (err: any) {
        if (err instanceof SharedInstructionsError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/shared-instructions/create", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const style = project.settings?.styleAppend?.trim();
    if (!style) {
      return reply.code(400).send({ error: "Write and save your project instructions first — they become the file's content." });
    }
    const dir = projectDir(project.id);
    const content = sharedInstructionsTemplate(style);
    const diff = await withProjectLock(project.id, async () => {
      if (existsSync(join(dir, SHARED_INSTRUCTIONS_FILE))) return null;
      writeFileSync(join(dir, SHARED_INSTRUCTIONS_FILE), content);
      return git.workingDiff(dir);
    });
    if (diff === null) {
      return reply.code(409).send({ error: `${SHARED_INSTRUCTIONS_FILE} already exists in the project — review it below instead.` });
    }
    // The user wrote these instructions themselves: this version counts as confirmed.
    const updated = updateProject(project.id, {
      sharedInstructions: { sha256: sha256(content), content, confirmedAt: new Date().toISOString() },
    })!;
    broadcast(project.id, { type: "diff", diff, changed: true });
    return { state: sharedInstructionsState(updated), diff };
  });
}
