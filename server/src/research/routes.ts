import { createJobSchema, researchJobs, listResearchJobs } from "./jobs.js";
import {
  librarySearchSchema,
  libraryStatus,
  searchLibrary,
} from "./library.js";
import { decideClaim, saveResearchPolicy, strictReport } from "./strict.js";
import {
  evaluationReport,
  importEvaluationCases,
  reviewEvaluationCase,
  evaluationCaseSchema,
} from "./evaluation.js";
import {
  buildGraph,
  expandGraph,
  graphQuerySchema,
  queryGraph,
  readGraph,
} from "./graph.js";
import type { GraphIndexer } from "./graph-indexer.js";
import { checkBibliography } from "./bibliography.js";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { getProject, projectDir } from "../config.js";
import { addCitation, readAllBibEntries } from "../citations.js";
import {
  getPaperContent,
  readPaper,
  formatPaperReadResult,
  verifyEntry,
} from "../papers.js";
import { evidenceView, localSourcePath, verifyClaim } from "./evidence.js";
import {
  analyzePaper,
  approveOutline,
  buildOutline,
  getOutline,
  matrixMarkdown,
  readMatrix,
  relatedWritingPrompt,
  reviewMatrixRow,
  type MatrixRow,
} from "./matrix.js";
import { memorySchema, readMemory, saveMemory } from "./memory.js";
import { getReview, resolveIssue, reviewManuscript } from "./review.js";
import {
  citationNeighbors,
  publicationStatus,
  readPublicationStatuses,
  screeningDecision,
  searchHistory,
  searchLiterature,
} from "./discovery.js";
import {
  configureZotero,
  importZotero,
  listZotero,
  publicZotero,
  zoteroSchema,
} from "./zotero.js";
import {
  inspectPaperPage,
  readingCapabilities,
  renderPdfPage,
  semanticPaperSearch,
} from "./pdfreading.js";
import { readStore, updateStore } from "./store.js";

const text = z.string().min(1).max(4000);
const keyBody = z.object({ key: text });
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
        const lock = `${id}:${suffix}:${req.body?.key ?? req.body?.claimId ?? ""}`;
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
  route("GET", "", null, (id, dir) => ({
    jobs: listResearchJobs(id),
    strict: strictReport(id, dir),
    library: libraryStatus(id, dir),
    bibliography: checkBibliography(dir),
    refs: readAllBibEntries(dir)
      .filter(({ entry }) => entry.type !== "string")
      .map(({ entry }) => ({
        key: entry.key,
        title: entry.fields.title ?? entry.key,
      })),
    evidence: evidenceView(id, dir),
    matrix: readMatrix(id, dir),
    outline: getOutline(id, dir),
    memory: readMemory(id),
    review: getReview(id, dir),
    searches: searchHistory(id),
    publicationStatus: readPublicationStatuses(id, dir),
    zotero: publicZotero(id),
    zoteroImports: readStore(id, "zotero-imports", {}),
  }));
  route("GET", "/jobs", null, (id) => listResearchJobs(id));
  route("POST", "/jobs", createJobSchema, (id, _dir, body) =>
    researchJobs.create(id, body),
  );
  route(
    "POST",
    "/jobs/:jobId",
    z.object({ action: z.enum(["pause", "resume", "cancel"]) }),
    (id, _dir, body, req) =>
      researchJobs.control(id, req.params.jobId, body.action),
  );
  route("PUT", "/policy", z.object({ strict: z.boolean() }), (id, _dir, body) =>
    saveResearchPolicy(id, body.strict),
  );
  route("GET", "/strict", null, strictReport);
  route(
    "PUT",
    "/strict/decision",
    z.object({
      id: text,
      fingerprint: text,
      reason: z.string().max(4000),
      accept: z.boolean(),
    }),
    (id, dir, body) => decideClaim(id, dir, body),
  );
  route("GET", "/library", null, libraryStatus);
  route("POST", "/library/search", librarySearchSchema, (id, dir, body) =>
    searchLibrary(id, dir, body),
  );
  route("GET", "/evaluation", null, (id) => evaluationReport(id));
  route(
    "PUT",
    "/evaluation/review",
    z.object({
      id: text,
      hash: text,
      expected: evaluationCaseSchema.shape.expected,
      reason: z.string().min(12).max(4000),
    }),
    (id, _dir, body) => reviewEvaluationCase(id, body),
  );
  route(
    "PUT",
    "/evaluation/cases",
    z.object({ cases: z.array(evaluationCaseSchema).min(1).max(500) }),
    (id, _dir, body) => importEvaluationCases(id, body.cases),
  );
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
  route("GET", "/capabilities", null, () => readingCapabilities());
  route(
    "POST",
    "/evidence/verify",
    z.object({ claimId: text }),
    (id, dir, body) => verifyClaim(id, dir, body.claimId),
  );
  route("POST", "/matrix/analyze", keyBody, (id, dir, body) =>
    analyzePaper(id, dir, body.key),
  );
  route(
    "PUT",
    "/matrix/review",
    z.object({
      key: text,
      notes: z.string().max(8000),
      reviewed: z.boolean(),
      at: text,
    }),
    (id, dir, body) =>
      reviewMatrixRow(id, dir, body.key, body.notes, body.reviewed, body.at),
  );
  route("DELETE", "/matrix/:key", null, (id, _dir, _body, req) => {
    updateStore<Record<string, MatrixRow>>(id, "matrix", {}, (rows) => {
      delete rows[req.params.key];
      return rows;
    });
    return { ok: true };
  });
  route("POST", "/outline", z.object({}), (id, dir) => buildOutline(id, dir));
  route(
    "PUT",
    "/outline",
    z.object({ text: z.string().min(1).max(40000), at: text }),
    (id, dir, body) => approveOutline(id, dir, body.text, body.at),
  );
  route("GET", "/writing-prompt", null, (id, dir) => ({
    prompt: relatedWritingPrompt(id, dir),
  }));
  route("GET", "/matrix/export", null, (id, dir) => ({
    markdown: matrixMarkdown(id, dir),
  }));
  route(
    "POST",
    "/review",
    z.object({ context: z.array(z.string()).max(30).default([]) }),
    (id, dir, body) => reviewManuscript(id, dir, body.context),
  );
  route(
    "PUT",
    "/review/issue",
    z.object({
      id: text,
      resolved: z.boolean(),
      note: z.string().max(4000),
      at: text,
    }),
    (id, dir, body) =>
      resolveIssue(id, body.id, body.resolved, body.note, body.at, dir),
  );
  route(
    "PUT",
    "/memory",
    z.object({ fields: memorySchema, revision: z.number().int().min(0) }),
    (id, _dir, body) => saveMemory(id, body.fields, body.revision),
  );
  route(
    "POST",
    "/search",
    z.object({
      query: text,
      limit: z.number().int().min(1).max(30).default(10),
      criteria: z.string().max(4000).default(""),
    }),
    (id, _dir, body) =>
      searchLiterature(id, body.query, body.limit, body.criteria),
  );
  route(
    "POST",
    "/neighbors",
    z.object({
      key: text,
      direction: z.enum(["references", "citing"]),
      cursor: z.string().max(1000).optional(),
    }),
    (id, dir, body) =>
      citationNeighbors(id, dir, body.key, body.direction, body.cursor),
  );
  route(
    "PUT",
    "/screen",
    z.object({
      runId: text,
      ref: text,
      decision: z.enum(["include", "exclude", "pending"]),
      reason: z.string().max(4000),
    }),
    (id, _dir, body) =>
      screeningDecision(id, body.runId, body.ref, body.decision, body.reason),
  );
  route("POST", "/publication-status", keyBody, (id, dir, body) =>
    publicationStatus(id, dir, body.key),
  );
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
  route("PUT", "/zotero", zoteroSchema, (id, _dir, body) =>
    configureZotero(id, body),
  );
  route(
    "POST",
    "/zotero/search",
    z.object({
      query: z.string().max(1000).default(""),
      start: z.number().int().min(0).default(0),
    }),
    (id, _dir, body) => listZotero(id, body.query, body.start),
  );
  route(
    "POST",
    "/zotero/import",
    z.object({ itemKey: z.string().regex(/^[A-Z0-9]{8}$/) }),
    (id, dir, body) => importZotero(id, dir, body.itemKey),
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
    "/semantic-search",
    z.object({ key: text, query: text }),
    (id, dir, body) => semanticPaperSearch(id, dir, body.key, body.query),
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
