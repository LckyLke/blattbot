import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CitationCheckResult, type ImportBibResult, type RefEntry, type RefsResponse } from "../api";
import { relTime } from "./Chat";

interface Props {
  projectId: string;
  /** Changes when chat activity happens — used to refresh the list. */
  stamp: number;
  /** True while an agent turn runs — manual .bib edits are disabled then. */
  busy: boolean;
  /** Jump to a citation site in the Source tab. */
  onJump: (file: string, line: number) => void;
  /** Manual .bib writes changed the working tree — pass the new diff up. */
  onDiff: (diff: string) => void;
  /** Hand a composed repair request to the agent (starts a turn in Edit mode). */
  onFixWithAgent: (prompt: string) => void;
}

/**
 * The repair request handed to the agent for a flagged entry. Everything the
 * agent needs is stated outright — the verdict, the evidence, and the entry's
 * own fields — so it starts from the audit's finding instead of re-deriving it,
 * and it is told to verify the result rather than declare success.
 */
export function buildFixPrompt(
  e: RefEntry,
  result: { status: string; detail?: string; url?: string },
): string {
  const facts = [
    `key: ${e.key}`,
    `file: ${e.file}`,
    e.title ? `title: ${e.title}` : null,
    e.author ? `author: ${e.author}` : null,
    e.year ? `year: ${e.year}` : null,
    e.doi ? `doi: ${e.doi}` : null,
  ].filter(Boolean);
  const verdict =
    result.status === "mismatch"
      ? "resolves to a DIFFERENT work than its title claims"
      : "could not be found in Crossref or OpenAlex at all";
  return [
    `The citation audit flagged \\cite{${e.key}} in ${e.file}: it ${verdict}.`,
    result.detail ? `Audit detail: ${result.detail}` : null,
    result.url ? `Evidence: ${result.url}` : null,
    "",
    "Current entry:",
    ...facts.map((f) => `- ${f}`),
    "",
    "Please fix it: search for the real publication (search_papers), then correct this entry in place so its fields match the actual record — do not add a second entry and do not change its cite key, since it is already cited in the text. If the work does not appear to exist at all, say so and propose removing the entry instead of inventing plausible fields. When you are done, run audit_citations on this key and report the new verdict.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const SOURCE_LABEL: Record<string, string> = {
  "s2-tldr": "Semantic Scholar TL;DR",
  agent: "condensed by agent",
  abstract: "abstract",
};

const ADD_SKELETON = "@article{key,\n  title = {},\n  author = {},\n  year = {}\n}";

/** Badge per audit status; `skipped` (network failure) renders no badge at all. */
const AUDIT_BADGE: Record<string, { glyph: string; cls: string; label: string }> = {
  verified: { glyph: "✓", cls: "text-leaf/80 hover:text-leaf", label: "Verified" },
  accepted: { glyph: "✓", cls: "text-leaf/60 hover:text-leaf", label: "Accepted by you" },
  unresolved: { glyph: "?", cls: "text-gold hover:text-gold", label: "Unresolved" },
  mismatch: { glyph: "⚠", cls: "text-pencil hover:text-pencil", label: "Title mismatch" },
};

const VERDICT_LABEL: Record<CitationCheckResult["verdict"], string> = {
  supported: "Supported",
  partially_supported: "Partially supported",
  not_supported: "Not supported",
  unclear: "Unclear",
};

const VERDICT_COLOR: Record<CitationCheckResult["verdict"], string> = {
  supported: "text-leaf",
  partially_supported: "text-gold",
  not_supported: "text-pencil",
  unclear: "text-graphite",
};

const CLAIM_GLYPH: Record<CitationCheckResult["verdict"], string> = {
  supported: "✓",
  partially_supported: "±",
  not_supported: "✗",
  unclear: "?",
};

export default function RefsPanel({ projectId, stamp, busy, onJump, onDiff, onFixWithAgent }: Props) {
  const [data, setData] = useState<RefsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showUndefined, setShowUndefined] = useState(false);
  const [tldrBusy, setTldrBusy] = useState<Set<string>>(new Set());
  const [pdfBusy, setPdfBusy] = useState<Set<string>>(new Set());
  const [verifyOpenId, setVerifyOpenId] = useState<string | null>(null);
  const [verifyClaim, setVerifyClaim] = useState("");
  const [verifyBusy, setVerifyBusy] = useState<Set<string>>(new Set());
  const [verifyResults, setVerifyResults] = useState<Record<string, CitationCheckResult & { claim: string }>>({});
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportBibResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState(ADD_SKELETON);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [verifyAllBusy, setVerifyAllBusy] = useState(false);
  const [verifyAllError, setVerifyAllError] = useState<string | null>(null);
  const [claimOpen, setClaimOpen] = useState<Set<string>>(new Set());
  const [gapsOnly, setGapsOnly] = useState(false);

  // Stale-async guard: the panel is not remounted on project switch (only the
  // projectId prop changes), so slow requests — the audit easily runs tens of
  // seconds, verify-all reads every paper and can run much longer — must
  // never splice their result into another project's view.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  useEffect(() => {
    setAuditBusy(false);
    setAuditError(null);
    setVerifyAllBusy(false);
    setVerifyAllError(null);
  }, [projectId]);

  const load = useCallback(() => {
    api
      .refs(projectId)
      .then((r) => {
        if (projectIdRef.current !== projectId) return;
        setData(r);
        setLoadError(null);
      })
      .catch((err) => {
        if (projectIdRef.current !== projectId) return;
        setLoadError(err.message);
      });
  }, [projectId]);

  useEffect(load, [load, stamp]);

  const entries = data?.entries ?? [];
  const undefinedKeys = data?.undefinedKeys ?? [];
  const unusedCount = data?.unusedCount ?? 0;

  const usageTotal = (e: RefEntry) => e.usage.reduce((n, u) => n + u.count, 0);

  const visible = entries.filter((e) => {
    if (unusedOnly && usageTotal(e) > 0) return false;
    if (gapsOnly) {
      const r = verifyResults[`${e.file}:${e.key}`] ?? data?.claimAudit?.results[e.key];
      if (!r || r.verdict === "supported") return false;
    }
    const q = filter.toLowerCase();
    if (!q) return true;
    return (
      e.key.toLowerCase().includes(q) ||
      (e.title ?? "").toLowerCase().includes(q) ||
      (e.author ?? "").toLowerCase().includes(q)
    );
  });

  const entryId = (e: RefEntry) => `${e.file}:${e.key}`;

  function patchEntry(e: RefEntry, patch: Partial<RefEntry>) {
    setData((d) =>
      d
        ? { ...d, entries: d.entries.map((x) => (entryId(x) === entryId(e) ? { ...x, ...patch } : x)) }
        : d,
    );
  }

  function setEntryError(e: RefEntry, message: string | null) {
    setEntryErrors((errs) => {
      const next = { ...errs };
      if (message) next[entryId(e)] = message;
      else delete next[entryId(e)];
      return next;
    });
  }

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(`\\cite{${key}}`);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function fetchTldr(e: RefEntry, force: boolean) {
    const id = entryId(e);
    setTldrBusy((s) => new Set(s).add(id));
    setEntryError(e, null);
    try {
      const r = await api.tldr(projectId, e.key, force);
      patchEntry(e, { summary: r.summary, summarySource: r.source });
    } catch (err: any) {
      setEntryError(e, err.message);
    } finally {
      setTldrBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function openPdf(e: RefEntry) {
    const url = api.refPdfUrl(projectId, e.key);
    if (e.hasPdf) {
      window.open(url, "_blank", "noopener");
      return;
    }
    // Open the tab synchronously (before the await) so popup blockers allow it.
    const tab = window.open("", "_blank");
    const id = entryId(e);
    setPdfBusy((s) => new Set(s).add(id));
    setEntryError(e, null);
    try {
      await api.fetchRefPdf(projectId, e.key);
      patchEntry(e, { hasPdf: true });
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener");
    } catch (err: any) {
      tab?.close();
      setEntryError(e, err.message);
    } finally {
      setPdfBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  function toggleVerify(e: RefEntry) {
    const id = entryId(e);
    setVerifyOpenId((open) => (open === id ? null : id));
    setVerifyClaim("");
    setEntryError(e, null);
  }

  async function runVerify(e: RefEntry) {
    const id = entryId(e);
    const claim = verifyClaim.trim();
    if (!claim) return;
    setVerifyBusy((s) => new Set(s).add(id));
    setEntryError(e, null);
    try {
      const r = await api.verifyRef(projectId, e.key, claim);
      setVerifyResults((m) => ({ ...m, [id]: { ...r, claim } }));
      setVerifyOpenId(null);
    } catch (err: any) {
      setEntryError(e, err.message);
    } finally {
      setVerifyBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function runImport() {
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const r = await api.importBib(projectId, importText);
      setImportResult(r);
      setImportText("");
      load();
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setImportBusy(false);
    }
  }

  function toggleUsage(id: string) {
    setUsageOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveNewEntry() {
    setAddBusy(true);
    setAddError(null);
    try {
      const r = await api.addRef(projectId, addText);
      onDiff(r.diff);
      setAddOpen(false);
      setAddText(ADD_SKELETON);
      load();
    } catch (err: any) {
      setAddError(err.message);
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(e: RefEntry) {
    setEditingId(entryId(e));
    setEditText(e.raw);
    setEditError(null);
  }

  async function saveEdit(e: RefEntry) {
    setEditBusy(true);
    setEditError(null);
    try {
      const r = await api.updateRef(projectId, e.key, editText);
      onDiff(r.diff);
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteEntry(e: RefEntry) {
    setConfirmDelete(null);
    setEntryError(e, null);
    try {
      const r = await api.deleteRef(projectId, e.key);
      onDiff(r.diff);
      load();
    } catch (err: any) {
      setEntryError(e, err.message);
    }
  }

  async function runAudit() {
    const startedFor = projectId;
    setAuditBusy(true);
    setAuditError(null);
    try {
      const audit = await api.auditRefs(projectId);
      if (projectIdRef.current !== startedFor) return;
      setData((d) => (d ? { ...d, audit } : d));
    } catch (err: any) {
      if (projectIdRef.current !== startedFor) return;
      setAuditError(err.message);
    } finally {
      if (projectIdRef.current === startedFor) setAuditBusy(false);
    }
  }

  const audit = data?.audit ?? null;
  const auditSummary = (() => {
    if (!audit) return null;
    const counts = { verified: 0, mismatch: 0, unresolved: 0, skipped: 0 };
    for (const r of Object.values(audit.results)) counts[r.status] += 1;
    return [
      `${counts.verified} verified`,
      counts.unresolved > 0 ? `${counts.unresolved} unresolved` : null,
      counts.mismatch > 0 ? `${counts.mismatch} mismatch` : null,
      counts.skipped > 0 ? `${counts.skipped} skipped` : null,
      `audited ${relTime(audit.at)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  })();

  /** Every cited entry checked against the text at its first \cite site — reads each paper, so it is slow. */
  async function runVerifyAll() {
    const startedFor = projectId;
    setVerifyAllBusy(true);
    setVerifyAllError(null);
    try {
      const claimAudit = await api.verifyAllRefs(projectId);
      if (projectIdRef.current !== startedFor) return;
      setData((d) => (d ? { ...d, claimAudit } : d));
    } catch (err: any) {
      if (projectIdRef.current !== startedFor) return;
      setVerifyAllError(err.message);
    } finally {
      if (projectIdRef.current === startedFor) setVerifyAllBusy(false);
    }
  }

  const claimAudit = data?.claimAudit ?? null;
  const claimGapCount = claimAudit
    ? Object.values(claimAudit.results).filter((r) => r.verdict !== "supported").length
    : 0;
  const claimSummary = (() => {
    if (!claimAudit) return null;
    const counts = { supported: 0, partially_supported: 0, not_supported: 0, unclear: 0 };
    for (const r of Object.values(claimAudit.results)) counts[r.verdict] += 1;
    return [
      `${counts.supported} supported`,
      counts.partially_supported > 0 ? `${counts.partially_supported} partial` : null,
      counts.not_supported > 0 ? `${counts.not_supported} NOT SUPPORTED` : null,
      counts.unclear > 0 ? `${counts.unclear} unclear` : null,
      claimAudit.skipped.length > 0 ? `${claimAudit.skipped.length} skipped (never cited)` : null,
      `checked ${relTime(claimAudit.at)}`,
    ]
      .filter(Boolean)
      .join(" · ");
  })();

  /** The result to show for an entry: a fresh manual check wins over a stale bulk-sweep one. */
  function claimResultFor(
    e: RefEntry,
  ): (CitationCheckResult & { claim: string; file?: string; line?: number }) | undefined {
    return verifyResults[entryId(e)] ?? claimAudit?.results[e.key];
  }

  /** Compact glyph next to the key — click to reveal the claim + explanation below. */
  function claimBadge(e: RefEntry) {
    const r = claimResultFor(e);
    if (!r) return null;
    const id = entryId(e);
    const open = claimOpen.has(id) || Boolean(verifyResults[id]);
    return (
      <button
        onClick={() =>
          setClaimOpen((s) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        title={`Claim check: ${VERDICT_LABEL[r.verdict]} — click to ${open ? "hide" : "show"} details`}
        aria-label={`Claim check for ${e.key}: ${VERDICT_LABEL[r.verdict]}`}
        aria-expanded={open}
        className={`shrink-0 rounded border border-current/30 px-1 font-mono text-[11px] transition-colors ${VERDICT_COLOR[r.verdict]}`}
      >
        {CLAIM_GLYPH[r.verdict]}
      </button>
    );
  }

  /** ✓ / ? / ⚠ next to the key, linking to the evidence when known. */
  function auditBadge(e: RefEntry) {
    const r = audit?.results[e.key];
    const badge = r && AUDIT_BADGE[r.accepted ? "accepted" : r.status];
    if (!r || !badge) return null; // never audited, or skipped (network failure)
    const title = r.detail ? `${badge.label} — ${r.detail}` : badge.label;
    const cls = `shrink-0 font-mono text-[11px] transition-colors ${badge.cls}`;
    return r.url ? (
      <a href={r.url} target="_blank" rel="noreferrer" title={title} aria-label={`Audit: ${badge.label.toLowerCase()} — ${e.key}`} className={cls}>
        {badge.glyph}
      </a>
    ) : (
      <span title={title} aria-label={`Audit: ${badge.label.toLowerCase()} — ${e.key}`} className={cls}>
        {badge.glyph}
      </span>
    );
  }

  /** Record the user's judgement that a flagged entry is actually sound. */
  async function acceptEntry(e: RefEntry) {
    setEntryError(e, null);
    try {
      const r = await api.acceptAudit(projectId, e.key);
      if (projectIdRef.current !== projectId) return;
      setData((d) => (d ? { ...d, audit: r.audit } : d));
    } catch (err: any) {
      setEntryError(e, err.message);
    }
  }

  /** "fix" / "ok" next to a flagged entry: repair it, or accept it as correct. */
  function fixButton(e: RefEntry) {
    const r = audit?.results[e.key];
    if (!r || r.accepted || (r.status !== "mismatch" && r.status !== "unresolved")) return null;
    return (
      <>
      <button
        onClick={() => void acceptEntry(e)}
        title="The audit is wrong — this reference is correct"
        aria-label={`Accept ${e.key} as correct`}
        className="shrink-0 rounded border border-rule px-1.5 py-0.5 font-mono text-[10px] text-graphite transition-colors hover:border-leaf hover:text-leaf"
      >
        ok
      </button>
      <button
        onClick={() => onFixWithAgent(buildFixPrompt(e, r))}
        disabled={busy}
        title={
          busy
            ? "An agent turn is already running"
            : `Ask the agent to investigate and correct ${e.key}`
        }
        aria-label={`Fix ${e.key} with the agent`}
        className="shrink-0 rounded border border-gold/50 px-1.5 py-0.5 font-mono text-[10px] text-gold transition-colors hover:border-gold hover:bg-gold/10 disabled:opacity-40"
      >
        fix
      </button>
      </>
    );
  }

  const chipBase =
    "rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-rule px-4 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${entries.length} entr${entries.length === 1 ? "y" : "ies"}…`}
          className="w-full rounded border border-rule bg-ink-2 px-3 py-1.5 text-[13px] text-paper placeholder:text-graphite/60"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {undefinedKeys.length > 0 && (
            <button
              onClick={() => setShowUndefined((v) => !v)}
              title="Keys cited in .tex files but missing from every .bib file"
              className={`${chipBase} ${
                showUndefined
                  ? "border-pencil bg-pencil/10 text-pencil"
                  : "border-pencil/50 text-pencil hover:border-pencil"
              }`}
            >
              ⚠ {undefinedKeys.length} undefined
            </button>
          )}
          <button
            onClick={() => setUnusedOnly((v) => !v)}
            title="Show only entries never cited in the text"
            className={`${chipBase} ${
              unusedOnly
                ? "border-gold bg-gold/10 text-gold"
                : "border-rule text-graphite hover:border-gold hover:text-gold"
            }`}
          >
            unused {unusedCount > 0 ? `(${unusedCount})` : ""}
          </button>
          <button
            onClick={runAudit}
            disabled={auditBusy || entries.length === 0}
            title="Check every entry against Crossref/OpenAlex — no AI involved"
            className={`${chipBase} disabled:opacity-50 ${
              auditBusy ? "border-gold text-gold" : "border-rule text-graphite hover:border-leaf hover:text-leaf"
            }`}
          >
            {auditBusy ? "auditing…" : "Audit citations"}
          </button>
          <button
            onClick={runVerifyAll}
            disabled={verifyAllBusy || entries.length === 0}
            title="Check every cited entry against the claim at its first \cite site — reads each paper; can take a while"
            className={`${chipBase} disabled:opacity-50 ${
              verifyAllBusy ? "border-gold text-gold" : "border-rule text-graphite hover:border-leaf hover:text-leaf"
            }`}
          >
            {verifyAllBusy ? "verifying…" : "Verify all"}
          </button>
          {claimAudit && (
            <button
              onClick={() => setGapsOnly((v) => !v)}
              title="Show only citations whose claim check found a gap"
              className={`${chipBase} ${
                gapsOnly
                  ? "border-pencil bg-pencil/10 text-pencil"
                  : claimGapCount > 0
                    ? "border-pencil/50 text-pencil hover:border-pencil"
                    : "border-rule text-graphite hover:border-leaf hover:text-leaf"
              }`}
            >
              gaps {claimGapCount > 0 ? `(${claimGapCount})` : ""}
            </button>
          )}
          <span className="ml-auto" />
          <button
            onClick={() => {
              setAddOpen((v) => !v);
              setAddError(null);
            }}
            disabled={busy}
            title="Write a new BibTeX entry by hand"
            className={`${chipBase} disabled:opacity-50 ${
              addOpen ? "border-leaf text-leaf" : "border-rule text-paper-dim hover:border-leaf hover:text-leaf"
            }`}
          >
            + add entry
          </button>
          <button
            onClick={() => setImportOpen((v) => !v)}
            className={`${chipBase} ${
              importOpen ? "border-leaf text-leaf" : "border-rule text-paper-dim hover:border-leaf hover:text-leaf"
            }`}
          >
            Import
          </button>
          <a
            href={api.exportBibUrl(projectId)}
            download="references.bib"
            className={`${chipBase} border-rule text-paper-dim hover:border-gold hover:text-gold`}
          >
            Export
          </a>
        </div>

        {auditSummary && (
          <p role="status" className="mt-1.5 font-mono text-[10.5px] text-graphite">
            {auditSummary}
          </p>
        )}
        {auditError && (
          <p role="status" className="mt-1.5 text-[11.5px] leading-snug text-pencil">
            {auditError}
          </p>
        )}
        {claimSummary && (
          <p role="status" className="mt-1 font-mono text-[10.5px] text-graphite">
            {claimSummary}
          </p>
        )}
        {verifyAllError && (
          <p role="status" className="mt-1.5 text-[11.5px] leading-snug text-pencil">
            {verifyAllError}
          </p>
        )}

        {showUndefined && undefinedKeys.length > 0 && (
          <ul className="mt-2 rounded border border-pencil/40 bg-ink-2 px-3 py-2">
            {undefinedKeys.map((u) => (
              <li key={u.key} className="flex items-baseline gap-2 py-0.5">
                <span className="font-mono text-[11px] text-pencil">{u.key}</span>
                <span className="truncate font-mono text-[10px] text-graphite">{u.files.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}

        {addOpen && (
          <div className="mt-2 rounded border border-rule bg-ink-2 p-2">
            <textarea
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              rows={6}
              aria-label="New BibTeX entry"
              spellCheck={false}
              className="w-full resize-y rounded border border-rule bg-ink px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-paper placeholder:text-graphite/60"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={saveNewEntry}
                disabled={busy || addBusy || !addText.trim()}
                aria-label="Save new entry"
                className="rounded border border-leaf/60 px-3 py-1 text-[12px] text-leaf transition-colors hover:bg-leaf/10 disabled:opacity-50"
              >
                {addBusy ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => {
                  setAddOpen(false);
                  setAddText(ADD_SKELETON);
                  setAddError(null);
                }}
                className="rounded border border-rule px-3 py-1 text-[12px] text-paper-dim transition-colors hover:border-graphite"
              >
                Cancel
              </button>
              <span className="text-[11px] text-graphite">one entry — a taken key is auto-renamed</span>
            </div>
            {addError && <p className="mt-1.5 text-[11.5px] leading-snug text-pencil">{addError}</p>}
          </div>
        )}

        {importOpen && (
          <div className="mt-2 rounded border border-rule bg-ink-2 p-2">
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={5}
              placeholder={"Paste BibTeX entries…\n@article{key, …}"}
              className="w-full resize-y rounded border border-rule bg-ink px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-paper placeholder:text-graphite/60"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                onClick={runImport}
                disabled={importBusy || !importText.trim()}
                className="rounded border border-leaf/60 px-3 py-1 text-[12px] text-leaf transition-colors hover:bg-leaf/10 disabled:opacity-50"
              >
                {importBusy ? "Adding…" : "Add"}
              </button>
              <span className="text-[11px] text-graphite">deduped by key, DOI, and title</span>
            </div>
            {importError && <p className="mt-1.5 text-[11.5px] leading-snug text-pencil">{importError}</p>}
            {importResult && (
              <div className="mt-1.5 text-[11.5px] leading-snug">
                <p className="text-leaf">
                  Added {importResult.added.length} to {importResult.bibFile}
                  {importResult.added.length > 0 && (
                    <span className="font-mono text-[10.5px]"> — {importResult.added.join(", ")}</span>
                  )}
                </p>
                {importResult.skipped.length > 0 && (
                  <p className="mt-0.5 text-gold">
                    Skipped{" "}
                    {importResult.skipped.map((s, i) => (
                      <span key={s.key + i}>
                        {i > 0 && ", "}
                        <span className="font-mono text-[10.5px]">{s.key}</span> ({s.reason})
                      </span>
                    ))}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {visible.map((e) => {
          const id = entryId(e);
          const total = usageTotal(e);
          const busyTldr = tldrBusy.has(id);
          const busyPdf = pdfBusy.has(id);
          const busyVerify = verifyBusy.has(id);
          const claimResult = claimResultFor(e);
          const claimIsOpen = claimOpen.has(id) || Boolean(verifyResults[id]);
          return (
            <li key={id} className="border-b border-rule/50 py-2.5 last:border-0">
              <div className="flex items-baseline gap-2">
                <button
                  onClick={() => copy(e.key)}
                  title="Copy \cite{…}"
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    copied === e.key
                      ? "border-leaf text-leaf"
                      : total > 0
                        ? "border-rule text-leaf hover:border-leaf"
                        : "border-rule text-gold hover:border-gold"
                  }`}
                >
                  {copied === e.key ? "copied" : e.key}
                </button>
                {auditBadge(e)}
                {claimBadge(e)}
                {fixButton(e)}
                {e.year && <span className="font-mono text-[11px] text-graphite">{e.year}</span>}
                {total > 0 ? (
                  <button
                    onClick={() => toggleUsage(id)}
                    aria-expanded={usageOpen.has(id)}
                    aria-label={`Show where ${e.key} is cited`}
                    title={e.usage.map((u) => `${u.file}:${u.lines.join(",")}`).join("  ")}
                    className="rounded-full border border-leaf/50 px-1.5 font-mono text-[10px] text-leaf transition-colors hover:border-leaf hover:bg-leaf/10"
                  >
                    ×{total}
                  </button>
                ) : (
                  <span
                    title="Never cited in any .tex file"
                    className="rounded-full border border-gold/50 px-1.5 font-mono text-[10px] text-gold"
                  >
                    unused
                  </span>
                )}
                <span className="ml-auto truncate font-mono text-[10px] text-graphite/60">{e.file}</span>
                {confirmDelete === id ? (
                  <button
                    onClick={() => deleteEntry(e)}
                    disabled={busy}
                    aria-label={`Really delete ${e.key}?`}
                    className="shrink-0 rounded bg-pencil/90 px-1.5 text-[10px] font-medium text-ink transition-colors hover:bg-pencil disabled:opacity-50"
                  >
                    really?
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(id)}
                    disabled={busy}
                    aria-label={`Delete ${e.key}`}
                    title={`Delete ${e.key} from ${e.file}`}
                    className="shrink-0 rounded px-1 font-mono text-[12px] leading-none text-graphite transition-colors hover:text-pencil disabled:opacity-50"
                  >
                    ×
                  </button>
                )}
              </div>

              {usageOpen.has(id) && total > 0 && (
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-rule/60 bg-ink-2 px-2 py-1">
                  {e.usage.map((u) => (
                    <span key={u.file} className="flex items-baseline gap-1 font-mono text-[10.5px]">
                      <span className="text-graphite">{u.file}:</span>
                      {u.lines.map((line, i) => (
                        <button
                          key={`${line}-${i}`}
                          onClick={() => onJump(u.file, line)}
                          aria-label={`${u.file}:${line}`}
                          title={`Jump to ${u.file} line ${line}`}
                          className="rounded border border-rule px-1 text-[10.5px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
                        >
                          {line}
                        </button>
                      ))}
                    </span>
                  ))}
                </div>
              )}
              {e.title && (
                <p className="mt-1 font-serif text-[13.5px] leading-snug text-paper">{e.title}</p>
              )}
              {e.author && <p className="mt-0.5 truncate text-[11.5px] text-graphite">{e.author}</p>}

              <div className="mt-1.5 flex items-center gap-2">
                {e.link && (
                  <a
                    href={e.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open the reference link for ${e.key}`}
                    title={e.link}
                    className="font-mono text-[10.5px] text-graphite transition-colors hover:text-gold"
                  >
                    link ↗
                  </a>
                )}
                <button
                  onClick={() => openPdf(e)}
                  disabled={busyPdf}
                  title={e.hasPdf ? "Open cached PDF" : "Fetch the open-access PDF, then open it"}
                  className={`font-mono text-[10.5px] transition-colors disabled:opacity-60 ${
                    e.hasPdf ? "text-leaf hover:text-leaf" : "text-graphite hover:text-paper-dim"
                  }`}
                >
                  {busyPdf ? "fetching…" : e.hasPdf ? "PDF ↗" : "PDF"}
                </button>
                {!e.summary && (
                  <button
                    onClick={() => fetchTldr(e, false)}
                    disabled={busyTldr}
                    className="font-mono text-[10.5px] text-graphite transition-colors hover:text-paper-dim disabled:opacity-60"
                  >
                    {busyTldr ? "summarizing…" : "TL;DR"}
                  </button>
                )}
                <button
                  onClick={() => (editingId === id ? setEditingId(null) : startEdit(e))}
                  disabled={busy}
                  aria-label={`Edit ${e.key}`}
                  title="Edit the raw BibTeX"
                  className={`font-mono text-[10.5px] transition-colors disabled:opacity-60 ${
                    editingId === id ? "text-leaf" : "text-graphite hover:text-paper-dim"
                  }`}
                >
                  edit
                </button>
                <button
                  onClick={() => toggleVerify(e)}
                  aria-label={`Check a claim against ${e.key}`}
                  title="Check whether this paper's own content supports a specific claim — reads its cached PDF, or its abstract if none is cached"
                  className={`font-mono text-[10.5px] transition-colors disabled:opacity-60 ${
                    verifyOpenId === id ? "text-leaf" : "text-graphite hover:text-paper-dim"
                  }`}
                >
                  verify
                </button>
              </div>

              {verifyOpenId === id && (
                <div className="mt-1.5 rounded border border-rule bg-ink-2 p-2">
                  <textarea
                    value={verifyClaim}
                    onChange={(ev) => setVerifyClaim(ev.target.value)}
                    rows={2}
                    placeholder="Paste the exact sentence this citation is attached to…"
                    aria-label={`Claim to check against ${e.key}`}
                    className="w-full resize-y rounded border border-rule bg-ink px-2 py-1.5 font-serif text-[12.5px] leading-relaxed text-paper placeholder:text-graphite/60"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      onClick={() => runVerify(e)}
                      disabled={busyVerify || !verifyClaim.trim()}
                      className="rounded border border-leaf/60 px-3 py-1 text-[12px] text-leaf transition-colors hover:bg-leaf/10 disabled:opacity-50"
                    >
                      {busyVerify ? "Reading paper…" : "Check"}
                    </button>
                    <button
                      onClick={() => setVerifyOpenId(null)}
                      className="rounded border border-rule px-3 py-1 text-[12px] text-paper-dim transition-colors hover:border-graphite"
                    >
                      Cancel
                    </button>
                    <span className="text-[11px] text-graphite">reads the cached PDF, or the abstract if none is cached</span>
                  </div>
                </div>
              )}

              {claimIsOpen && claimResult && (
                <div className="mt-1.5 rounded border border-rule/60 bg-ink-2 px-2.5 py-2">
                  <p className="font-mono text-[9.5px] uppercase tracking-wide text-graphite/70">
                    Claim: <span className="normal-case text-graphite">"{claimResult.claim}"</span>
                    {claimResult.file && claimResult.line !== undefined && (
                      <button
                        onClick={() => onJump(claimResult.file!, claimResult.line!)}
                        className="ml-1.5 normal-case text-graphite underline decoration-dotted transition-colors hover:text-leaf"
                      >
                        jump to source
                      </button>
                    )}
                  </p>
                  <p className={`mt-1 font-mono text-[10.5px] font-medium ${VERDICT_COLOR[claimResult.verdict]}`}>
                    {VERDICT_LABEL[claimResult.verdict]}
                    <span className="ml-1.5 font-normal text-graphite/70">
                      ({claimResult.basis === "full_text" ? "full paper" : "abstract only"})
                    </span>
                  </p>
                  <p className="mt-1 font-serif text-[12.5px] leading-relaxed text-paper-dim">
                    {claimResult.explanation}
                  </p>
                </div>
              )}

              {editingId === id && (
                <div className="mt-1.5 rounded border border-rule bg-ink-2 p-2">
                  <textarea
                    value={editText}
                    onChange={(ev) => setEditText(ev.target.value)}
                    rows={Math.min(14, editText.split("\n").length + 1)}
                    aria-label={`BibTeX source of ${e.key}`}
                    spellCheck={false}
                    className="w-full resize-y rounded border border-rule bg-ink px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-paper"
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      onClick={() => saveEdit(e)}
                      disabled={busy || editBusy || !editText.trim()}
                      aria-label={`Save changes to ${e.key}`}
                      className="rounded border border-leaf/60 px-3 py-1 text-[12px] text-leaf transition-colors hover:bg-leaf/10 disabled:opacity-50"
                    >
                      {editBusy ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded border border-rule px-3 py-1 text-[12px] text-paper-dim transition-colors hover:border-graphite"
                    >
                      Cancel
                    </button>
                    <span className="text-[11px] text-graphite">a changed key renames the entry</span>
                  </div>
                  {editError && (
                    <p className="mt-1.5 text-[11.5px] leading-snug text-pencil">{editError}</p>
                  )}
                </div>
              )}

              {e.summary && (
                <div className="mt-1.5 rounded border border-rule/60 bg-ink-2 px-2.5 py-2">
                  <p className="font-serif text-[12.5px] leading-relaxed text-paper-dim">{e.summary}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="font-mono text-[9.5px] uppercase tracking-wide text-graphite/70">
                      {SOURCE_LABEL[e.summarySource ?? ""] ?? e.summarySource}
                    </span>
                    <button
                      onClick={() => fetchTldr(e, true)}
                      disabled={busyTldr}
                      aria-label={`Regenerate the summary of ${e.key}`}
                      title="Regenerate summary"
                      className="font-mono text-[11px] text-graphite transition-colors hover:text-gold disabled:opacity-60"
                    >
                      {busyTldr ? "…" : "↻"}
                    </button>
                  </div>
                </div>
              )}
              {entryErrors[id] && (
                <p className="mt-1 text-[11px] leading-snug text-pencil">{entryErrors[id]}</p>
              )}
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="py-8 text-center font-serif text-sm text-graphite">
            {loadError
              ? loadError
              : entries.length === 0
                ? "No bibliography entries yet. Ask BlattBot to find and add citations."
                : "Nothing matches the filter."}
          </li>
        )}
      </ul>
    </div>
  );
}
