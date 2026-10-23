// References manager: list, metadata, audit, claim checks, edits, TL;DRs,
// paper PDFs, and bibliography import/export.
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { deleteUnusedReferences, unusedReferenceEntries } from "../unused-references.js";
import { getProject, projectDir } from "../config.js";
import * as git from "../git.js";
import {
  addRefEntry,
  deleteRefEntry,
  exportBibliography,
  importBibtex,
  readAllBibEntries,
  updateRefEntry,
} from "../citations.js";
import { collectCiteUsage, usageReport } from "../usage.js";
import {
  NoPdfError,
  RateLimitError,
  arxivIdFromEntry,
  acceptAuditEntry,
  auditCitations,
  ensurePaperPdf,
  getTldr,
  paperPdfPath,
  readAudit,
  readClaimAudit,
  readPaperStore,
  sanitizeKeyForFile,
  verifyAllCitations,
  verifyCitationSupport,
} from "../papers.js";
import type { BibEntry } from "../bib.js";
import { cachedReferenceMetadata, getReferenceMetadata } from "../reference-metadata.js";
import { isTurnActive } from "../agent.js";
import { broadcast } from "../events.js";
import { withProjectLock } from "../project-lock.js";

// ---- References: Zotero-lite citation manager ------------------------------

/** Best source link for a bib entry: DOI → arXiv abstract page → url field. */
function refLink(entry: BibEntry): string | null {
  const doi = entry.fields.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) return `https://doi.org/${doi}`;
  const arxivId = arxivIdFromEntry(entry);
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
  if (entry.fields.url?.trim()) return entry.fields.url.trim();
  return null;
}

export function registerRefRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/refs", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const dir = projectDir(project.id);
    const all = readAllBibEntries(dir);
    const usage = collectCiteUsage(dir);
    const store = readPaperStore(project.id);
    const { undefinedKeys } = usageReport(all.map((x) => x.entry.key), usage);
    const unusedKeys = new Set(unusedReferenceEntries(dir, all).map(({ entry }) => entry.key));
    const entries = all.map(({ file, entry }) => {
      const rec = store[entry.key];
      return {
        file,
        key: entry.key,
        type: entry.type,
        title: entry.fields.title ?? null,
        author: entry.fields.author ?? null,
        year: entry.fields.year ?? null,
        doi: entry.fields.doi ?? null,
        link: refLink(entry),
        usage: usage[entry.key] ?? [],
        unused: unusedKeys.has(entry.key),
        raw: entry.raw,
        summary: rec?.summary,
        summarySource: rec?.source,
        hasPdf: Boolean(paperPdfPath(project.id, entry.key, store)),
        ...cachedReferenceMetadata(project.id, entry, store),
      };
    });
    return {
      entries,
      undefinedKeys,
      unusedCount: entries.filter(entry => entry.unused).length,
      audit: readAudit(project.id),
      claimAudit: readClaimAudit(project.id),
    };
  });

  app.get<{ Params: { id: string; key: string }; Querystring: { file?: string } }>("/api/projects/:id/refs/:key/metadata", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const match = readAllBibEntries(projectDir(project.id)).find(({ file, entry }) => entry.key === req.params.key && (!req.query.file || file === req.query.file));
    if (!match) return reply.code(404).send({ error: "unknown reference" });
    return { raw: match.entry.raw, metadata: await getReferenceMetadata(project.id, match.entry) };
  });

  // Deterministic citation audit: every entry checked against Crossref/OpenAlex
  // (no LLM). The result is persisted so the badges survive reloads.
  app.post<{ Params: { id: string } }>("/api/projects/:id/refs/audit", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    try {
      return await auditCitations(project.id, projectDir(project.id));
    } catch (err: any) {
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  });

  // Project-wide claim check: every cited entry against the text at its first
  // \cite site (verify_citation_support run in bulk). Unlike the deterministic
  // audit above this reads each paper and calls an LLM, so it is slow for a
  // large bibliography — the result is persisted so the report survives reloads.
  app.post<{ Params: { id: string } }>("/api/projects/:id/refs/verify-all", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    try {
      return await verifyAllCitations(project.id, projectDir(project.id));
    } catch (err: any) {
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  });

  // The audit's checks are heuristic — accepting an entry records the user's
  // judgement that a flagged reference is sound (until the entry itself changes).
  app.post<{ Params: { id: string }; Body: { key?: string } }>(
    "/api/projects/:id/refs/audit/accept",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
      if (!key) return reply.code(400).send({ error: "key is required" });
      try {
        const result = acceptAuditEntry(project.id, projectDir(project.id), key);
        return { key, result, audit: readAudit(project.id) };
      } catch (err: any) {
        return reply.code(404).send({ error: err?.message ?? String(err) });
      }
    },
  );

  // Manual reference edits are ordinary working-tree changes: every write below
  // recomputes the working diff and broadcasts it so the Proof view stays live.

  app.post<{ Params: { id: string }; Body: { bibtex?: string; bibFile?: string } }>(
    "/api/projects/:id/refs",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const bibtex = req.body?.bibtex ?? "";
      if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
      const dir = projectDir(project.id);
      const bibFile = req.body?.bibFile?.trim() || undefined;
      if (bibFile) {
        const abs = resolve(dir, bibFile);
        if (abs === dir || !abs.startsWith(dir + sep)) {
          return reply.code(400).send({ error: "invalid path" });
        }
      }
      try {
        const { result, diff } = await withProjectLock(project.id, async () => {
          const result = addRefEntry(dir, bibtex, bibFile);
          return { result, diff: await git.workingDiff(dir) };
        });
        broadcast(project.id, { type: "diff", diff });
        return { ok: true, key: result.key, diff };
      } catch (err: any) {
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.put<{ Params: { id: string; key: string }; Body: { bibtex?: string } }>(
    "/api/projects/:id/refs/:key",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const bibtex = req.body?.bibtex ?? "";
      if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
      const dir = projectDir(project.id);
      try {
        const { result, diff } = await withProjectLock(project.id, async () => {
          const result = updateRefEntry(dir, req.params.key, bibtex);
          return { result, diff: await git.workingDiff(dir) };
        });
        broadcast(project.id, { type: "diff", diff });
        return { ok: true, key: result.key, diff };
      } catch (err: any) {
        if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/refs/delete-unused", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
    const dir = projectDir(project.id);
    try {
      const { deleted, diff } = await withProjectLock(project.id, async () => {
        const deleted = deleteUnusedReferences(dir);
        return { deleted, diff: await git.workingDiff(dir) };
      });
      broadcast(project.id, { type: "diff", diff });
      return { ok: true, deleted, diff };
    } catch (err: any) {
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  });

  app.delete<{ Params: { id: string; key: string } }>(
    "/api/projects/:id/refs/:key",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const dir = projectDir(project.id);
      try {
        const diff = await withProjectLock(project.id, async () => {
          deleteRefEntry(dir, req.params.key);
          return git.workingDiff(dir);
        });
        broadcast(project.id, { type: "diff", diff });
        return { ok: true, diff };
      } catch (err: any) {
        if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.post<{ Params: { id: string; key: string }; Body: { force?: boolean } }>(
    "/api/projects/:id/refs/:key/tldr",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      try {
        return await getTldr(project.id, projectDir(project.id), req.params.key, {
          force: Boolean(req.body?.force),
        });
      } catch (err: any) {
        if (err instanceof RateLimitError) return reply.code(429).send({ error: err.message });
        if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.post<{ Params: { id: string; key: string } }>("/api/projects/:id/refs/:key/pdf", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    try {
      await ensurePaperPdf(project.id, projectDir(project.id), req.params.key);
      return { ok: true };
    } catch (err: any) {
      if (err instanceof NoPdfError) return reply.code(404).send({ error: err.message });
      if (err instanceof RateLimitError) return reply.code(429).send({ error: err.message });
      if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
      return reply.code(422).send({ error: err?.message ?? String(err) });
    }
  });

  app.get<{ Params: { id: string; key: string } }>("/api/projects/:id/refs/:key/pdf", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const path = paperPdfPath(project.id, req.params.key);
    if (!path) return reply.code(404).send({ error: "no cached PDF — fetch it first" });
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `inline; filename="${sanitizeKeyForFile(req.params.key)}.pdf"`);
    return reply.type("application/pdf").send(createReadStream(path));
  });

  /** Manual, on-demand version of the agent's verify_citation_support tool — not persisted. */
  app.post<{ Params: { id: string; key: string }; Body: { claim?: string } }>(
    "/api/projects/:id/refs/:key/verify",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const claim = req.body?.claim?.trim() ?? "";
      if (!claim) return reply.code(400).send({ error: "claim is required" });
      try {
        return await verifyCitationSupport(project.id, projectDir(project.id), req.params.key, claim);
      } catch (err: any) {
        if (/^unknown citation key/.test(err?.message ?? "")) return reply.code(404).send({ error: err.message });
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { bibtex?: string; bibFile?: string } }>(
    "/api/projects/:id/bib/import",
    async (req, reply) => {
      const project = getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      if (isTurnActive(project.id)) return reply.code(409).send({ error: "agent turn in progress" });
      const bibtex = req.body?.bibtex ?? "";
      if (!bibtex.trim()) return reply.code(400).send({ error: "bibtex is required" });
      const dir = projectDir(project.id);
      const bibFile = req.body?.bibFile?.trim() || undefined;
      if (bibFile) {
        const abs = resolve(dir, bibFile);
        if (abs === dir || !abs.startsWith(dir + sep)) {
          return reply.code(400).send({ error: "invalid path" });
        }
      }
      try {
        const { result, diff } = await withProjectLock(project.id, async () => {
          const result = importBibtex(dir, bibtex, bibFile);
          return { result, diff: await git.workingDiff(dir) };
        });
        broadcast(project.id, { type: "diff", diff });
        return result;
      } catch (err: any) {
        return reply.code(422).send({ error: err?.message ?? String(err) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/bib/export", async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const text = exportBibliography(projectDir(project.id));
    if (!text) return reply.code(404).send({ error: "no .bib entries in this project" });
    reply.header("Content-Disposition", `attachment; filename="references.bib"`);
    return reply.type("text/x-bibtex").send(text);
  });
}
