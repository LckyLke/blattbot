import { readingNotes, saveReadingNote, archiveReadingNote, checkReadingNote, noteSchema } from "./reading.js";
import { createLibraryJobSchema, researchJobs, listResearchJobs } from "./jobs.js";
import { librarySearchSchema, libraryStatus, searchLibrary } from "./library.js";
import { buildGraph, graphDetails, expandGraph, graphQuerySchema, queryGraph, readGraph } from "./graph.js";
import type { GraphIndexer } from "./graph-indexer.js";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { getProject, projectDir } from "../config.js";
import { addCitation } from "../citations.js";
import { getPaperContent, readPaper, formatPaperReadResult, verifyEntry } from "../papers.js";
import { localSourcePath } from "./evidence.js";
import { inspectPaperPage, readingCapabilities, renderPdfPage } from "./pdfreading.js";
import { attachRepository, attachRepositorySchema, listRepositories, queryRepository, refreshRepository, removeRepository, repositoryQuerySchema, browseLocalRepositories } from "../repositories.js";
import { codeAssessments, codeClaimSchema, verifyCodeClaim } from "./code-evidence.js";

const text = z.string().min(1).max(4000);
const running = new Set<string>();
export function registerResearchRoutes(
  app: FastifyInstance,
  onBibChange: (id: string) => Promise<void>,
  indexer?: GraphIndexer,
) {
  function route(
    method: "GET" | "POST" | "PUT" | "DELETE",
    suffix: string,
    schema: z.ZodType | null,
    fn: (id: string, dir: string, body: any, req: any) => any,
    bibliography = false,
  ) {
    app.route({
      method,
      url: `/api/projects/:id/research${suffix}`,
      handler: async (req: any, reply) => {
        const id = req.params.id;
        if (!getProject(id))
          return reply.code(404).send({ error: "unknown project" });
        const lock = `${id}:${suffix}:${req.body?.key ?? req.body?.claimId ?? req.body?.node ?? req.body?.id ?? ""}`;
        if (method !== "GET" && running.has(lock))
          return reply
            .code(409)
            .send({ error: "This research operation is already running." });
        try {
          const body = schema ? schema.parse(req.body ?? {}) : req.body;
          if (bibliography && (await import("../agent.js")).isTurnActive(id))
            return reply.code(409).send({
              error:
                "Wait for the writing turn to finish before changing the bibliography.",
            });
          if (method !== "GET") running.add(lock);
          const result = await fn(id, projectDir(id), body, req);
          if (bibliography) {
            await onBibChange(id);
            indexer?.request(id, projectDir(id));
          }
          return result;
        } catch (error: any) {
          return reply
            .code(error instanceof z.ZodError ? 400 : 422)
            .send({ error: error.message ?? String(error) });
        } finally {
          if (method !== "GET") running.delete(lock);
        }
      },
    });
  }
  route("GET", "/repositories", null, (id) => listRepositories(id));
  route("GET", "/repositories/local", null, (_id, _dir, _body, req) =>
    browseLocalRepositories(z.object({ path: z.string().max(4000).optional() }).parse(req.query).path));
  route("POST", "/repositories", attachRepositorySchema, (id, _dir, body) => attachRepository(id, body));
  route("POST", "/repositories/refresh", z.object({ repositoryId: text }), (id, _dir, body) => refreshRepository(id, body.repositoryId));
  route("POST", "/repositories/remove", z.object({ repositoryId: text }), (id, _dir, body) => removeRepository(id, body.repositoryId));
  route("POST", "/repositories/inspect", repositoryQuerySchema, (id, _dir, body) => queryRepository(id, body));
  route("GET", "/code-evidence", null, (id, dir) => codeAssessments(id, dir));
  route("POST", "/code-evidence", codeClaimSchema, (id, dir, body) => verifyCodeClaim(id, dir, body));
  route("GET", "", null, (id, dir) => ({
    jobs: listResearchJobs(id).filter(job => job.kind === "library-index"),
    library: libraryStatus(id, dir),
  }));
  route("GET", "/jobs", null, id => listResearchJobs(id).filter(job => job.kind === "library-index"));
  route("POST", "/jobs", createLibraryJobSchema, (id, _dir, body) => researchJobs.create(id, body));
  route("POST", "/jobs/:jobId", z.object({ action: z.enum(["pause", "resume", "cancel"]) }), (id, _dir, body, req) => {
    if (!listResearchJobs(id).some(job => job.id === req.params.jobId && job.kind === "library-index")) throw new Error("Unknown library indexing job");
    return researchJobs.control(id, req.params.jobId, body.action);
  });
  route("GET", "/library", null, libraryStatus);
  route("POST", "/library/search", librarySearchSchema, (id, dir, body) => searchLibrary(id, dir, body));
  route("GET", "/notes", null, (id, dir, _body, req) => readingNotes(id, dir, z.object({ key: z.string().max(1000).optional() }).parse(req.query).key));
  route("POST", "/notes", noteSchema, (id, dir, body) => saveReadingNote(id, dir, body));
  route("POST", "/notes/archive", z.object({ id: z.string().uuid(), revision: z.number().int().min(1), archived: z.boolean() }), (id, dir, body) => archiveReadingNote(id, dir, body.id, body.revision, body.archived));
  route("POST", "/notes/check", z.object({ id: z.string().uuid(), revision: z.number().int().min(1) }), (id, dir, body) => checkReadingNote(id, dir, body.id, body.revision));
  route("GET", "/graph", null, (id, dir) => ({
    ...readGraph(id, dir),
    indexing: indexer?.request(id, dir),
  }));
  route("POST", "/graph/retry", z.object({}), (id, dir) => ({
    ...readGraph(id, dir),
    indexing: indexer?.request(id, dir, true),
  }));
  route(
    "POST",
    "/graph/build",
    z.object({ keys: z.array(text).min(1).max(30).optional() }),
    (id, dir, body) => buildGraph(id, dir, body.keys),
  );
  route("POST", "/graph/expand", z.object({ node: text }), (id, dir, body) =>
    expandGraph(id, dir, body.node),
  );
  route("POST", "/graph/query", graphQuerySchema, (id, dir, body) =>
    queryGraph(id, dir, body),
  );
  route("POST", "/graph/details", z.object({ node: text }), (id, dir, body) =>
    graphDetails(id, dir, body.node),
  );
  route("GET", "/capabilities", null, () => readingCapabilities());
  route(
    "POST",
    "/add-reference",
    z.object({ ref: text }),
    async (id, dir, body) => {
      const added = await addCitation(dir, body.ref);
      const verification = await verifyEntry(id, dir, added.key);
      return { ...added, verification };
    },
    true,
  );
  route(
    "POST",
    "/read",
    z.object({
      key: text,
      path: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      query: z.string().max(1000).optional(),
      ocr: z.boolean().optional(),
      page: z.number().int().min(1).max(1000).optional(),
    }),
    async (id, dir, body) => ({
      text: formatPaperReadResult(await readPaper(id, dir, body.key, body)),
    }),
  );
  route(
    "POST",
    "/inspect-page",
    z.object({
      key: text,
      page: z.number().int().min(1).max(1000),
      question: text,
    }),
    (id, dir, body) =>
      inspectPaperPage(id, dir, body.key, body.page, body.question),
  );
  route("GET", "/source/:key/:page", null, async (id, dir, _body, req) => {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(req.params.page);
    const source = await getPaperContent(id, dir, req.params.key);
    if (page > source.pages.length)
      throw new Error(
        "This page is unavailable. Read or attach the correct PDF first.",
      );
    return {
      title: source.title,
      key: source.key,
      page,
      basis: source.basis,
      totalPages: source.pages.length,
      text:
        source.pages[page - 1] ||
        "No extractable text on this page. Inspect the image or run OCR.",
      source: source.source,
      limitations: source.limitations,
    };
  });
  app.get<{ Params: { id: string; key: string; page: string } }>(
    "/api/projects/:id/research/page-image/:key/:page",
    async (req, reply) => {
      const { id, key } = req.params;
      if (!getProject(id))
        return reply.code(404).send({ error: "unknown project" });
      try {
        const path = localSourcePath(id, projectDir(id), key);
        if (!path) throw new Error("Read or attach this PDF first");
        const image = await renderPdfPage(
          path,
          z.coerce.number().int().min(1).max(1000).parse(req.params.page),
        );
        reply.header("Cache-Control", "no-store");
        return reply.type("image/png").send(createReadStream(image));
      } catch (error: any) {
        return reply.code(422).send({ error: error.message });
      }
    },
  );
}
