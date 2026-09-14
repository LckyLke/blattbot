import {
  librarySearchSchema,
  libraryStatus,
  searchLibrary,
} from "./library.js";
import { evidencePage, evidencePageSchema, strictReportPage, strictPageSchema } from "./report-pages.js";
import { createJobSchema, researchJobs, listResearchJobs } from "./jobs.js";
import {
  buildGraph,
  expandGraph,
  graphQuerySchema,
  queryGraph,
} from "./graph.js";
import { z } from "zod";
import { checkBibliography } from "./bibliography.js";
import type { BackendTurnContext } from "../backends/types.js";
import { verifyClaim } from "./evidence.js";
import {
  analyzePaper,
  buildOutline,
  getOutline,
  readMatrix,
  relatedWritingPrompt,
} from "./matrix.js";
import { memorySchema, proposeMemory, readMemory } from "./memory.js";
import { reviewManuscript } from "./review.js";
import { citationNeighbors, publicationStatus } from "./discovery.js";
import { inspectPaperPage, semanticPaperSearch } from "./pdfreading.js";

function define(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  run: (ctx: BackendTurnContext, args: any) => Promise<unknown> | unknown,
) {
  return { name, description, shape, schema: z.object(shape), run };
}
const key = z.string().min(1);
export const RESEARCH_TOOLS = [
  define(
    "search_library",
    "Search the persisted full-text index of all project papers, with page-located passages and explicit stale/missing/abstract-only coverage. semantic expands query terms; matches do not establish support or contradiction. If sources need indexing, start a library-index research task, then query again.",
    librarySearchSchema.shape,
    (ctx, args) => searchLibrary(ctx.project.id, ctx.dir, args),
  ),
  define(
    "strict_evidence_report",
    "Read a bounded page of cited and uncited evidence issues, with the strict writing policy and global readiness always included. Filter by status (open/accepted), key or file; use offset/limit and returned nextOffset to continue. Only the user may change policy or accept an evidence exception. Use verify_evidence and a strict-audit research task to check gaps.",
    strictPageSchema.shape,
    (ctx, args) => strictReportPage(ctx.project.id, ctx.dir, args),
  ),
  define(
    "research_tasks",
    "Start or inspect durable Research tasks; pause, resume or cancel a task by jobId. Use evidence (claim IDs), matrix (cite keys), library-index (cite keys), strict-audit, outline, evaluation (case IDs), or review (context paths). Completed items survive restart. Startup interruptions pause until resumed. No manuscript edits occur. Inspect status to report failures and coverage.",
    {
      action: z.enum(["list", "start", "pause", "resume", "cancel"]),
      jobId: z.string().optional(),
      task: createJobSchema.optional(),
    },
    (ctx, args) => {
      if (args.action === "list")
        return {
          jobs: listResearchJobs(ctx.project.id),
          library: libraryStatus(ctx.project.id, ctx.dir),
        };
      if (args.action === "start") {
        if (!args.task) throw new Error("task required");
        return researchJobs.create(ctx.project.id, args.task);
      }
      if (!args.jobId) throw new Error("jobId required");
      return researchJobs.control(ctx.project.id, args.jobId, args.action);
    },
  ),
  define(
    "query_citation_graph",
    "Query the saved directed citation graph as structured JSON. Queries: overview, citations (node: key or ID; current manuscript file/line/column, surrounding passage, citation vs bibliography inclusion), neighbors (outgoing references/incoming citers/both), shared_references (nodes: >=2 keys or IDs), missing (absent works ranked by how many project works cite them), path (node → target, maxDepth). Pagination uses limit/offset. Node IDs and project citation keys both work. Only loaded indexed edges are queried: missing data is unknown. Citation connections are not evidence of a claim. Build/expand the graph when needed.",
    graphQuerySchema.shape,
    (ctx, args) => queryGraph(ctx.project.id, ctx.dir, args),
  ),
  define(
    "update_citation_graph",
    "Fetch citation graph data from OpenAlex. build resolves up to 20 pending bibliography keys (or specified keys, max 30); expand loads references of a graph node. Results persist across chats. This reads metadata and does not change the bibliography. Read and assess any candidate paper before adding or citing it.",
    {
      action: z.enum(["build", "expand"]),
      keys: z.array(key).max(30).optional(),
      node: key.optional(),
    },
    async (ctx, args) => {
      if (args.action === "expand" && !args.node)
        throw new Error("node is required");
      const graph =
        args.action === "expand"
          ? await expandGraph(ctx.project.id, ctx.dir, args.node)
          : await buildGraph(ctx.project.id, ctx.dir, args.keys);
      return {
        at: graph.at,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        pendingKeys: graph.pendingKeys,
        errors: graph.errors,
        truncated: graph.truncated,
        note: graph.note,
        next: "Use query_citation_graph for structured, paginated results.",
      };
    },
  ),
  define(
    "check_bibliography",
    "Check citation keys against .bib entries: undefined or duplicate keys, case collisions, duplicate DOI/title records and missing metadata. Keys are arbitrary. Use audit_citations for publication identity and compile for BibTeX/Biber syntax.",
    {},
    (ctx) => checkBibliography(ctx.dir),
  ),
  define(
    "list_evidence",
    "List a bounded page of cited manuscript claims with global status counts. Filter by status, key or file; use offset/limit and returned nextOffset to continue. Set include_details for bounded evidence details. Stale means the claim or source changed; unchecked means no stored assessment. Use verify_evidence to inspect exact quotations, page numbers and source versions.",
    evidencePageSchema.shape,
    (ctx, args) => evidencePage(ctx.project.id, ctx.dir, args),
  ),
  define(
    "verify_evidence",
    "Check a claim ID returned by list_evidence. Persists source-versioned evidence with exact quotes validated against the paper. Does not edit manuscript text. Returns uncertainty for missing/unlocatable evidence.",
    { claimId: z.string() },
    (ctx, args) => verifyClaim(ctx.project.id, ctx.dir, args.claimId),
  ),
  define(
    "literature_matrix",
    "Optional literature analysis: read a comparison matrix, analyze a paper into source-backed fields, or draft an outline when requested. These steps are not prerequisites for writing. writing_prompt supports drafting directly into the editable Proof diff; the user edits and approves that draft. Verify original sources and never treat unchecked/missing cells as facts.",
    {
      action: z.enum(["read", "analyze", "outline", "writing_prompt"]),
      key: key.optional(),
    },
    (ctx, args) => {
      if (args.action === "analyze") {
        if (!args.key) throw new Error("key is required");
        return analyzePaper(ctx.project.id, ctx.dir, args.key);
      }
      if (args.action === "outline")
        return buildOutline(ctx.project.id, ctx.dir);
      if (args.action === "writing_prompt")
        return relatedWritingPrompt(ctx.project.id, ctx.dir);
      return {
        matrix: readMatrix(ctx.project.id, ctx.dir),
        outline: getOutline(ctx.project.id, ctx.dir),
      };
    },
  ),
  define(
    "review_manuscript",
    "Run scientific consistency checks: claims versus results, numbers, comparable metrics/datasets, causal wording, definitions/notation. Findings contain validated manuscript/context quotes and record exactly which inputs were inspected. Optional contextPaths must be attached text/CSV/code files. Does not edit files.",
    { contextPaths: z.array(z.string()).max(30).optional() },
    (ctx, args) => reviewManuscript(ctx.project.id, ctx.dir, args.contextPaths),
  ),
  define(
    "project_memory",
    "Read user-approved project memory, or propose a replacement for user review. Proposals NEVER change accepted memory. Keep research question, contribution, definitions, notation, methods, decisions and open questions explicit.",
    {
      action: z.enum(["read", "propose"]),
      fields: memorySchema.optional(),
      reason: z.string().max(2000).optional(),
    },
    (ctx, args) => {
      if (args.action === "read") return readMemory(ctx.project.id);
      if (!args.fields || !args.reason)
        throw new Error("fields and reason are required for a proposal");
      return proposeMemory(ctx.project.id, args.fields, args.reason);
    },
  ),
  define(
    "explore_citations",
    "Find a paper's references (backward) or works citing it (forward) through OpenAlex. Results and retrieval dates are recorded in Research search history. Pass a returned cursor for further results. Index coverage is incomplete; do not claim exhaustive retrieval.",
    {
      key,
      direction: z.enum(["references", "citing"]),
      cursor: z.string().optional(),
    },
    (ctx, args) =>
      citationNeighbors(
        ctx.project.id,
        ctx.dir,
        args.key,
        args.direction,
        args.cursor,
      ),
  ),
  define(
    "check_publication_status",
    "Check a cited work for indexed retraction/correction/update flags. Reports source and check time. Not flagged does not guarantee absence of a retraction; unavailable is not a clean bill of health.",
    { key },
    (ctx, args) => publicationStatus(ctx.project.id, ctx.dir, args.key),
  ),
  define(
    "search_paper_content",
    "Find passages by meaning, synonyms, or multilingual phrasing within a paper. Returns only source-locatable quotations with page numbers, expanded search phrases, and retrieval limitations. Use read_paper to inspect surrounding context.",
    { key, query: z.string().min(1).max(1000) },
    (ctx, args) =>
      semanticPaperSearch(ctx.project.id, ctx.dir, args.key, args.query, {
        contextDirs: ctx.contextDirs,
      }),
  ),
  define(
    "inspect_paper_page",
    "Render and inspect one PDF page visually to read tables, figures, equations or scans. Requires Poppler, Tesseract for scanned title identification, and an image-capable model. The output is a fallible visual interpretation, clearly labeled; state unreadable content and verify numbers against the page image.",
    {
      key,
      page: z.number().int().min(1).max(1000),
      question: z.string().min(1).max(2000),
    },
    (ctx, args) =>
      inspectPaperPage(
        ctx.project.id,
        ctx.dir,
        args.key,
        args.page,
        args.question,
      ),
  ),
];
export async function executeResearchTool(
  ctx: BackendTurnContext,
  name: string,
  args: unknown,
): Promise<string> {
  const tool = RESEARCH_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error("unknown research tool");
  const result = await tool.run(ctx, tool.schema.parse(args ?? {}));
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if ((result as any)?.error || (result as any)?.verdict === "unclear")
    ctx.emit({
      type: "notice",
      tone: "warn",
      text: `${name}: ${(result as any).error ?? (result as any).explanation}`,
    });
  if (text.length <= 100_000) return text;
  return JSON.stringify({
    error:
      "Result exceeds the tool response limit. Query fewer nodes/claims, reduce limit or use pagination. No partial JSON data returned.",
    characters: text.length,
  });
}
