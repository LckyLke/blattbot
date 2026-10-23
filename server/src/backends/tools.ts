/**
 * BlattBot's own model tools, defined once for every backend: each entry holds
 * the tool's name, description, input schema, handler and argument summary.
 * The backends only adapt this list:
 *
 *  - Claude (claude.ts) serves the `claude: true` entries through its SDK MCP
 *    server. The others have native Claude Code equivalents (Read, Write,
 *    Edit, Glob, AskUserQuestion).
 *  - The OpenAI-compatible backend and Codex (openai.ts, codex.ts) get every
 *    entry as a function definition, without the `writes` entries in read-only
 *    modes.
 *
 * Handlers receive the raw arguments: the Claude SDK validates them against the
 * schema first, while function-calling models may send anything, so every
 * handler checks what it uses. A handler that throws yields
 * "<name> failed: <message>" as an error result on every backend.
 *
 * The research tools (research/tools.ts) join the same list via one adapter
 * and keep their own validation and result formatting.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { compileWorkingTree } from "../compile-service.js";
import { addCitation, formatAddCitationResult, readAllBibEntries } from "../citations.js";
import { auditEntries, formatAuditReport, verifyEntry } from "../papers.js";
import { findBibFiles, listFiles } from "../latex.js";
import { readPdfFile, readTextDocument, formatTextExcerpt } from "../pdftext.js";
import { askUserQuestions, validateQuestions, MAX_HEADER, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "../questions.js";
import { chatUploadsDir, imageSize, sniffImageMime } from "../chatimages.js";
import { RESEARCH_TOOLS, executeResearchTool } from "../research/tools.js";
import { searchLiterature } from "../research/discovery.js";
import { readPaperTool, verifyPaperTool } from "./paper-tools.js";
import { displayPath, isInside, resolveReadPath, resolveWritePath } from "./paths.js";
import { SEARCH_MAX_CONTEXT_LINES, SEARCH_MAX_LIMIT, searchFiles } from "./search-files.js";
import type { BackendTurnContext } from "./types.js";

/** read_file refuses files larger than this (keeps prompts sane); search_files skips them. */
export const MAX_READ_BYTES = 512 * 1024;

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export interface ProjectTool {
  name: string;
  description: string;
  /** Input schema. Claude's SDK validates against it; the function-calling backends get its JSON Schema. */
  shape: z.ZodRawShape;
  /** The tool name events carry on every backend (livediff, chat labels and resultHead key off it). */
  event: string;
  /** Served by the Claude backend's MCP server too. */
  claude: boolean;
  /** Changes the project: left out of read-only catalogs, and the handler refuses in read-only modes. */
  writes: boolean;
  run(ctx: BackendTurnContext, args: any): Promise<string | ToolOutcome> | string | ToolOutcome;
  /** One-line summary of the arguments for the chat; summarizeToolInput's default otherwise. */
  summarize?(args: any, dir: string): string;
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const err = (content: string): ToolOutcome => ({ content, isError: true });

function define(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  run: ProjectTool["run"],
  opts: Partial<Pick<ProjectTool, "event" | "claude" | "writes" | "summarize">> = {},
): ProjectTool {
  return { name, description, shape, run, event: opts.event ?? `mcp__blattbot__${name}`, claude: opts.claude ?? true, writes: opts.writes ?? false, summarize: opts.summarize };
}

function requireString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

/** Strict parsing for tools whose handlers rely on the schema, with readable errors. */
function parseArgs<T extends z.ZodRawShape>(shape: T, args: unknown): z.infer<z.ZodObject<T>> {
  try {
    return z.object(shape).parse(args ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
    }
    throw error;
  }
}

/**
 * What read_file answers for a chat attachment: what the file is, not what its
 * bytes say. Returns null when the file is not one of the accepted image
 * formats, so anything else in that directory falls through to the normal
 * text path. Exported for the test that pins the note/behaviour agreement.
 */
export function describeChatImage(abs: string, bytes: number): string | null {
  let buf: Buffer;
  try {
    // The header is all this needs — never load megabytes to describe them.
    buf = readFileSync(abs).subarray(0, 64 * 1024);
  } catch {
    return null;
  }
  const mime = sniffImageMime(buf);
  if (!mime) return null;
  const size = imageSize(buf, mime);
  return (
    `${basename(abs)} is an image the user attached to this conversation: ` +
    `${mime}, ${bytes} bytes${size ? `, ${size.width}×${size.height} px` : ""}. ` +
    `It has no text content to read — the picture itself was sent with the ` +
    `message it belongs to.`
  );
}

// ---- Schemas shared by several tools -----------------------------------------

const filePath = z.string().describe("File path, relative to the project root");
const offset = z.number().int().min(0).optional().describe("Character offset returned by a previous read/search; default 0");
const limit = z.number().int().min(100).max(40000).optional().describe("Maximum text characters, default 20000");
const READ_QUERY = "Optional literal phrase to search throughout the text file or PDF, ignoring case and whitespace differences";

const searchFilesShape = {
  query: z.string().min(1).max(1000).describe("Text to find on a single line: literal by default, or a JavaScript regular expression with regex=true"),
  regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression; default false (literal text)"),
  caseSensitive: z.boolean().optional().describe("Match uppercase/lowercase exactly; default false"),
  path: z.string().max(2000).optional().describe("Only search files under this path prefix (a file, a directory, or the start of a name), relative to the project root, or an absolute path inside attached context; default the whole project"),
  contextLines: z.number().int().min(0).max(SEARCH_MAX_CONTEXT_LINES).optional().describe(`Lines to include before and after each match, 0–${SEARCH_MAX_CONTEXT_LINES}; default 0`),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Maximum matching lines to return, 1–${SEARCH_MAX_LIMIT}; default 50`),
};

// ---- The registry ---------------------------------------------------------------

const RESEARCH = RESEARCH_TOOLS.map((tool) =>
  define(tool.name, tool.description, tool.shape, (ctx, args) => executeResearchTool(ctx, tool.name, args)),
);

const FILE_TOOLS: ProjectTool[] = [
  define(
    "list_files",
    "List every file in the project working tree (relative paths).",
    {},
    (ctx) => {
      const files = listFiles(ctx.dir);
      return files.length ? files.join("\n") : "(the project has no files yet)";
    },
    { event: "list_files", claude: false },
  ),
  define(
    "search_files",
    "Search the text of project files, like grep: literal text by default, or a JavaScript regular expression with regex=true, matched line by line and case-insensitive unless caseSensitive=true. Searches the files list_files shows (never .git), or only those under path, which may also be an absolute path inside attached context. Returns path:line:text for each matching line, with contextLines of surrounding text, up to limit matches. Binary files and PDFs are skipped; use read_file with query for PDFs.",
    searchFilesShape,
    (ctx, args) => {
      const input = parseArgs(searchFilesShape, args);
      return searchFiles(ctx.dir, ctx.contextDirs, input, { maxFileBytes: MAX_READ_BYTES, signal: ctx.signal });
    },
    {
      summarize: (args, dir) => {
        const query = typeof args.query === "string" ? args.query : "";
        const where = typeof args.path === "string" && args.path.trim() ? displayPath(dir, resolve(dir, args.path.trim())) : "";
        return where ? `${query} in ${where}` : query;
      },
    },
  ),
  define(
    "read_file",
    "Read a text file or extract PDF text with page labels — a path relative to the project root, or an absolute attached-context path. Text files and PDFs support character offset/limit (default 0/20000, max 40000), with total length and next offset. Text-file offsets refer to the original file. query searches a case-insensitive, whitespace-normalized phrase. For a cited paper use read_paper with its key and optional path so source access is recorded.",
    { path: filePath, offset, limit, query: z.string().optional().describe(READ_QUERY) },
    async (ctx, args) => {
      const uploads = chatUploadsDir(ctx.project.id);
      const abs = resolveReadPath(ctx.dir, ctx.contextDirs, args?.path, [uploads]);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error("not a file");
      // The attachment note names these paths and says they are readable, so
      // the model does open them. They are pictures: a byte read would only
      // ever answer "binary file" (and most are over MAX_READ_BYTES anyway).
      // Describe the image instead — the pixels themselves already rode
      // along as image content in the user's message.
      if (isInside(abs, uploads)) {
        const described = describeChatImage(abs, st.size);
        if (described) return described;
      }
      if (abs.toLowerCase().endsWith(".pdf")) {
        const content = await readPdfFile(abs, args);
        if (content.startsWith("NO READABLE TEXT") || content.includes(" No text on pages ")) {
          ctx.emit({ type: "notice", tone: "warn", text: content.split("\n\n")[0] });
        }
        return content;
      }
      if (st.size > MAX_READ_BYTES) throw new Error(`file too large to read (${st.size} bytes)`);
      const buf = readFileSync(abs);
      if (buf.includes(0)) throw new Error("binary file — cannot read as text");
      return formatTextExcerpt(readTextDocument(buf.toString("utf8"), args)).replace("entire paper", "entire file").replace("All extracted text", "All text");
    },
    { event: "Read", claude: false },
  ),
];

const PAPER_TOOLS: ProjectTool[] = [
  define(
    "read_paper",
    "Read a cited paper's actual content before writing about it. Pass its bibliography key; optionally supply path for an uploaded/attached PDF or url for a public PDF or paper landing page. Tries indexes, publisher/repository pages and web discovery; matching sources are cached. Returns PDF text with page labels, a clearly labeled abstract or publisher/chapter summary, or an explicit missing-source report. Use refresh=true to retry a recent unsuccessful lookup. Use query to find exact phrases throughout the paper; use offset/limit to read later text or more search matches. Excerpts and missing text are labeled. PDFs must match the bibliography title; never infer content from metadata or search results.",
    {
      key: z.string().describe("Bibliography cite key of the paper to read"),
      path: z.string().optional().describe("Optional project-relative or absolute attached-context PDF path; remembered for this entry"),
      url: z.string().url().max(8000).optional().describe("Public PDF or repository/publisher page; downloads and remembers a title-matched PDF. Use either path or url."),
      refresh: z.boolean().optional().describe("Retry failed source discovery immediately, or refresh a supplied URL"),
      offset,
      limit,
      query: z.string().min(1).optional().describe(READ_QUERY),
      ocr: z.boolean().optional().describe("Run OCR on page 1 and the requested page; requires Poppler and Tesseract"),
      page: z.number().int().min(1).max(1000).optional().describe("PDF page to OCR when ocr=true"),
    },
    (ctx, args) => {
      const { key, ...opts } = args ?? {};
      return readPaperTool(ctx, requireString({ key }, "key"), opts);
    },
  ),
];

const EDIT_TOOLS: ProjectTool[] = [
  define(
    "write_file",
    "Create or overwrite a file inside the project with the given content.",
    { path: filePath, content: z.string().describe("Full new file content") },
    (ctx, args) => {
      if (ctx.readOnly) throw new Error("file edits are disabled in this read-only mode");
      const abs = resolveWritePath(ctx.dir, ctx.contextDirs, args?.path, ctx.scope);
      const content = requireString(args, "content");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `Wrote ${displayPath(ctx.dir, abs)} (${Buffer.byteLength(content)} bytes).`;
    },
    { event: "Write", claude: false, writes: true },
  ),
  define(
    "edit_file",
    "Replace one exact, unique text snippet in a project file (old_string must occur exactly once).",
    {
      path: filePath,
      old_string: z.string().describe("Exact text to replace — must occur exactly once in the file"),
      new_string: z.string().describe("Replacement text"),
    },
    (ctx, args) => {
      if (ctx.readOnly) throw new Error("file edits are disabled in this read-only mode");
      const abs = resolveWritePath(ctx.dir, ctx.contextDirs, args?.path, ctx.scope);
      const oldString = requireString(args, "old_string");
      const newString = requireString(args, "new_string");
      if (!oldString) throw new Error("old_string must not be empty");
      if (oldString === newString) throw new Error("old_string and new_string are identical");
      let text: string;
      try {
        const buf = readFileSync(abs);
        if (buf.includes(0)) throw new Error("binary file");
        text = buf.toString("utf8");
      } catch (e: any) {
        throw new Error(e?.code === "ENOENT" ? "no such file — use write_file to create files" : e.message);
      }
      const first = text.indexOf(oldString);
      if (first === -1) throw new Error("old_string not found in the file — read the file and match its exact text");
      if (text.indexOf(oldString, first + 1) !== -1) {
        throw new Error("old_string occurs more than once — include more surrounding context to make it unique");
      }
      writeFileSync(abs, text.slice(0, first) + newString + text.slice(first + oldString.length));
      return `Edited ${displayPath(ctx.dir, abs)}.`;
    },
    { event: "Edit", claude: false, writes: true },
  ),
  // Read-only (it just talks to the user) — available in every mode.
  define(
    "ask_user",
    "Ask the user 1-4 multiple-choice questions and wait for the answers. Use this to clarify ambiguous instructions or offer choices mid-task; the user sees clickable options and may also type a free-text answer or skip.",
    {
      questions: z.array(z.object({
        question: z.string().describe("The complete question to ask, ending with a question mark."),
        header: z.string().max(MAX_HEADER).describe(`Very short chip label (max ${MAX_HEADER} chars), e.g. "Approach".`),
        options: z.array(z.object({
          label: z.string().describe("Concise display text (1-5 words)."),
          description: z.string().describe("What choosing this option means."),
        })).min(MIN_OPTIONS).max(MAX_OPTIONS)
          .describe("2-4 distinct choices. Do not add an 'Other' option — the UI provides free-text input automatically."),
        multiSelect: z.boolean().optional().describe("Allow selecting multiple options (answers arrive comma-separated)."),
      })).min(1).max(MAX_QUESTIONS).describe("The questions to ask the user (1-4)."),
    },
    async (ctx, args) => {
      // Same flow as the Claude backend's AskUserQuestion: block on the
      // pending-question registry until the user answers/dismisses (the
      // question events reach the UI through ctx.emit) or the turn aborts.
      const questions = validateQuestions(args?.questions);
      const resolution = await askUserQuestions(ctx.project.id, ctx.emit, questions, [ctx.signal]);
      if (resolution.kind === "answered") return JSON.stringify({ answers: resolution.answers });
      if (resolution.kind === "dismissed") {
        return JSON.stringify({ declined: true, note: "User declined to answer; proceed with your best judgment." });
      }
      // Aborted — the caller's signal check right after this call throws.
      return err("the turn was interrupted before the questions were answered");
    },
    { event: "AskUserQuestion", claude: false },
  ),
];

const CITATION_TOOLS: ProjectTool[] = [
  define(
    "compile_latex",
    "Compile the LaTeX project and report success or the exact compiler errors. Use this to verify your edits.",
    {},
    async (ctx) => {
      // The shared build: the PDF preview shows it, and the refresh after the
      // turn reuses it when nothing changed since.
      const result = await compileWorkingTree(ctx.project.id);
      const engine = result.program && result.program !== result.engine ? `${result.engine} (${result.program})` : result.engine;
      if (result.ok) {
        return `Compilation succeeded with ${engine} in ${result.durationMs}ms (main file: ${result.mainTex}).`;
      }
      return (
        `Compilation FAILED (engine: ${engine}, main file: ${result.mainTex || "not found"}).\n` +
        `Errors:\n${result.errors.join("\n---\n")}\n\nLog tail:\n${result.logTail.slice(-2000)}`
      );
    },
  ),
  define(
    "search_papers",
    "Search academic literature across Semantic Scholar, DBLP, and Crossref in parallel — Semantic Scholar and DBLP cover ML venues (NeurIPS, ICML, ICLR) that Crossref misses. Returns title, authors, year, venue, citation count, and a cite-ref to pass to add_citation.",
    {
      query: z.string().describe("Free-text search, e.g. 'attention is all you need transformer'"),
      limit: z.number().int().min(1).max(15).optional().describe("Max results, default 5"),
    },
    async (ctx, args) => {
      const q = requireString(args, "query");
      const max = typeof args?.limit === "number" ? Math.max(1, Math.min(15, Math.floor(args.limit))) : 5;
      try {
        const run = await searchLiterature(ctx.project.id, q, max);
        if (run.error) throw new Error(run.error);
        const hits = run.results;
        if (hits.length === 0) return "No results found — try different phrasing or author names.";
        return hits.map(
          (h, i) =>
            `${i + 1}. ${h.title} — ${h.authors}${h.year ? ` (${h.year})` : ""}${h.venue ? `, ${h.venue}` : ""}` +
            `${h.citations != null ? ` [${h.citations} citations]` : ""}\n   cite-ref: ${h.ref}  (via ${h.source})`,
        ).join("\n");
      } catch (e: any) {
        return `Search failed: ${e?.message ?? e}`;
      }
    },
  ),
  define(
    "add_citation",
    "Fetch BibTeX for a cite-ref — a DOI, dblp:<key>, or arxiv:<id> as returned by search_papers — dedupe against the project's bibliography, and append it to a .bib file. The new entry is immediately verified against Crossref/OpenAlex and the verdict is reported back. Returns the cite key to use in \\cite{...}.",
    {
      ref: z.string().describe("A DOI, or dblp:<key> / arxiv:<id> exactly as returned by search_papers"),
      bibFile: z.string().optional().describe("Relative path of the .bib file to append to; defaults to the project's existing .bib"),
    },
    async (ctx, args) => {
      if (ctx.readOnly) throw new Error("adding citations is disabled in this read-only mode");
      const ref = requireString(args, "ref");
      let bibFile = typeof args?.bibFile === "string" && args.bibFile.trim() ? args.bibFile.trim() : undefined;
      // A scoped turn names its target up front (a scoped .bib when there is
      // one), so the scope check below sees the file addCitation would write.
      if (!bibFile && ctx.scope?.length) {
        const bibs = findBibFiles(ctx.dir);
        bibFile = ctx.scope.find((f) => f.endsWith(".bib")) ?? bibs[0] ?? "references.bib";
      }
      // The write fence first (symlinks, .git, context dirs, scope); addCitation
      // then insists on a .bib target inside the project.
      if (bibFile) resolveWritePath(ctx.dir, ctx.contextDirs, bibFile, ctx.scope);
      try {
        const result = await addCitation(ctx.dir, ref, bibFile);
        // Verify immediately: a bad reference must surface while the agent is
        // still in the turn that added it, not at review time.
        const verification =
          result.status === "added" ? await verifyEntry(ctx.project.id, ctx.dir, result.key) : undefined;
        return formatAddCitationResult(result, verification);
      } catch (e: any) {
        return `add_citation failed: ${e?.message ?? e}`;
      }
    },
    { writes: true },
  ),
  define(
    "list_citations",
    "List all entries currently in the project's .bib files (key, title, year).",
    {},
    (ctx) => {
      const all = readAllBibEntries(ctx.dir);
      if (all.length === 0) return "The project has no .bib entries yet.";
      return all.map(
        ({ file, entry }) =>
          `\\cite{${entry.key}} — ${entry.fields.title ?? "(no title)"}${entry.fields.year ? ` (${entry.fields.year})` : ""} [${file}]`,
      ).join("\n");
    },
  ),
  // Read-only: available in every mode, including review and understand.
  define(
    "audit_citations",
    "Verify bibliography entries against Crossref and OpenAlex — no guessing, just record lookups. Pass keys to check specific entries (use this on any BibTeX you wrote by hand) or omit them to check the whole bibliography. Reports each entry as verified, mismatch (resolves to a different work), unresolved (no record found — possibly fabricated), or skipped (lookup unavailable).",
    { keys: z.array(z.string()).optional().describe("Cite keys to verify; omit to verify every entry in the bibliography") },
    async (ctx, args) => {
      const keys = Array.isArray(args?.keys)
        ? args.keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "")
        : undefined;
      try {
        const { results, unknownKeys } = await auditEntries(ctx.project.id, ctx.dir, keys);
        return formatAuditReport(results, unknownKeys);
      } catch (e: any) {
        return `audit_citations failed: ${e?.message ?? e}`;
      }
    },
  ),
  define(
    "verify_citation_support",
    "Check whether a cited paper's own content actually supports a specific claim attributed to it — unlike audit_citations, which only confirms the reference is real, this reads the paper (its cached open-access PDF, or its abstract when no PDF is available) and judges the claim against it. Batch by paper: pass key and claims (1–12 exact statements) for one model request; claim remains supported for a single statement. Results are reused for unchanged claims and source content. Returns SUPPORTED, PARTIALLY_SUPPORTED, NOT_SUPPORTED, or UNCLEAR with an explanation.",
    {
      key: z.string().describe("The cite key (as used in \\cite{...}) of the reference to check"),
      claim: z.string().optional().describe("One exact claim; prefer claims for several statements from the same paper"),
      claims: z.array(z.string().min(1).max(16000)).min(1).max(12).optional().describe("Exact claims about this paper, checked together"),
    },
    async (ctx, args) => {
      const key = requireString(args, "key");
      try {
        if ((args.claim === undefined) === (args.claims === undefined)) throw new Error("Pass either claim or claims, not both");
        if (args.claims !== undefined && !Array.isArray(args.claims)) throw new Error("claims must be an array");
        return await verifyPaperTool(ctx, key, args.claims ?? requireString(args, "claim"));
      } catch (e: any) {
        return `verify_citation_support failed: ${e?.message ?? e}`;
      }
    },
  ),
];

/** Every BlattBot tool, in catalog order. */
export const PROJECT_TOOLS: readonly ProjectTool[] = [...RESEARCH, ...FILE_TOOLS, ...PAPER_TOOLS, ...EDIT_TOOLS, ...CITATION_TOOLS];

const BY_NAME = new Map(PROJECT_TOOLS.map((tool) => [tool.name, tool]));

/**
 * Literature and source tools: finding, adding, reading and checking papers,
 * the paper library and the citation graph.
 */
const LITERATURE_TOOLS = [
  "search_papers",
  "add_citation",
  "audit_citations",
  "verify_citation_support",
  "read_paper",
  "search_library",
  "library_index",
  "query_citation_graph",
  "update_citation_graph",
  "inspect_paper_page",
];

/**
 * Tools a mode leaves out of its catalog, so a turn does not carry their
 * descriptions. Polish proofreads and keeps content and citations exactly as
 * they are, so it needs neither literature nor repository tools. Every other
 * mode keeps the whole catalog: drafting and research use the paper tools,
 * and the read-only modes rely on the citation and claim checks. Codex keeps
 * the whole catalog in every mode: its tools are fixed when a conversation
 * starts.
 */
const MODE_EXCLUDED: Record<string, ReadonlySet<string>> = {
  polish: new Set([...LITERATURE_TOOLS, "inspect_repository", "verify_code_claim", "list_code_evidence"]),
};

/** Modes whose prompt leaves out the literature-tool instructions too. */
export const LEAN_MODES: ReadonlySet<string> = new Set(Object.keys(MODE_EXCLUDED));

/** The tools a turn in `mode` is offered (all of them for an unknown or absent mode). */
export function modeTools(mode?: string): readonly ProjectTool[] {
  const excluded = mode ? MODE_EXCLUDED[mode] : undefined;
  return excluded ? PROJECT_TOOLS.filter((tool) => !excluded.has(tool.name)) : PROJECT_TOOLS;
}

/**
 * The project tools the Claude backend serves besides the research tools,
 * with their descriptions — for the /api/agent/info transparency listing.
 */
export const AGENT_TOOL_INFO = PROJECT_TOOLS
  .filter((tool) => tool.claude && !RESEARCH_TOOLS.some((r) => r.name === tool.name))
  .map(({ name, description }) => ({ name, description }));

/** Model-facing tool name → the event name shared by every backend; unknown names pass through. */
export function eventToolName(name: string): string {
  return BY_NAME.get(name)?.event ?? name;
}

/** Run one tool call. Never throws: failures come back as error outcomes. */
export async function executeTool(ctx: BackendTurnContext, name: string, args: any): Promise<ToolOutcome> {
  try {
    ctx.signal.throwIfAborted();
    const tool = BY_NAME.get(name);
    if (!tool) return err(`unknown tool: ${name}`);
    // A catalog trimmed for the mode (not Codex's fixed one) is also the allowlist.
    if (ctx.toolset && !ctx.toolset.has(name)) return err(`${name} is not available in this mode`);
    const out = await tool.run(ctx, args);
    return typeof out === "string" ? ok(out) : out;
  } catch (e: any) {
    return err(`${name} failed: ${e?.message ?? e}`);
  }
}

function clip(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

/**
 * Compact, UI-friendly summary of a tool call's input, for every backend:
 * BlattBot's tools (plain or mcp__blattbot__-prefixed) and Claude Code's
 * native tools alike. The native-only argument names come first; no BlattBot
 * tool takes file_path, pattern or command.
 */
export function summarizeToolInput(name: string, input: any, dir: string): string {
  if (input == null || typeof input !== "object") return "";
  try {
    const own = BY_NAME.get(name.replace(/^mcp__blattbot__/, ""))?.summarize;
    if (own) return own(input, dir);
    if (typeof input.file_path === "string") {
      if (input.file_path.startsWith(dir)) return input.file_path.slice(dir.length).replace(/^\//, "");
      return input.file_path.split("/").slice(-2).join("/");
    }
    if (typeof input.pattern === "string") return input.pattern;
    if (typeof input.command === "string") return clip(input.command);
    if (typeof input.path === "string" && input.path.trim()) {
      const p = input.path.trim();
      return displayPath(dir, isAbsolute(p) ? resolve(p) : resolve(dir, p));
    }
    if (typeof input.query === "string") return input.query;
    if (typeof input.ref === "string") return input.ref;
    if (Array.isArray(input.questions) && typeof input.questions[0]?.question === "string") {
      return clip(input.questions[0].question);
    }
    if (Object.keys(input).length === 0) return "";
    return clip(JSON.stringify(input));
  } catch {
    return "";
  }
}
