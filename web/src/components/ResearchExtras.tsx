import { useEffect, useState } from "react";
import { api } from "../api";
import type { LibraryStatus, ResearchJob, StrictReport } from "../research";
type Act = <T>(label: string, task: () => Promise<T>) => Promise<T | undefined>;
export function ResearchTasks({
  projectId,
  jobs,
  onChanged,
}: {
  projectId: string;
  jobs: ResearchJob[];
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  async function control(jobId: string, action: string) {
    setPending(jobId);
    setError("");
    try {
      await api.research(projectId, `/jobs/${jobId}`, { action });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(undefined);
    }
  }
  const active = jobs.filter((j) =>
    ["queued", "running", "paused"].includes(j.state),
  );
  if (!jobs.length) return null;
  return (
    <details className="research-task-list">
      <summary>
        Tasks{" "}
        {active.length ? `· ${active.length} active or paused` : "· up to date"}
      </summary>
      {error && <p role="alert" className="research-error">{error}</p>}
      {[...jobs]
        .reverse()
        .map((job) => (
          <div key={job.id} className="research-task">
            <div className="research-section-heading">
              <strong>{job.kind.replaceAll("-", " ")}</strong>
              <span>
                {job.state} ·{" "}
                {job.items.filter((i) => i.state === "done").length}/
                {job.items.length}
              </span>
            </div>
            <progress
              max={job.items.length || 1}
              value={job.items.filter((i) => i.state !== "pending").length}
            />
            {job.currentKey && (
              <p className="research-meta">{job.currentKey}</p>
            )}
            {job.message && <p className="research-meta">{job.message}</p>}
            <div className="research-actions">
              {(["queued", "running"].includes(job.state)
                ? ["pause", "cancel"]
                : ["paused", "failed", "cancelled"].includes(job.state)
                  ? ["resume"]
                  : []
              ).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={pending !== undefined}
                  onClick={() => void control(job.id, action)}
                >
                  {action === "resume"
                    ? "Resume / retry"
                    : action === "pause"
                      ? "Pause"
                      : "Cancel"}
                </button>
              ))}
            </div>
            {job.items.some((i) => i.error) && (
              <details>
                <summary>Failed items</summary>
                {job.items
                  .filter((i) => i.error)
                  .map((i) => (
                    <p key={i.key} className="research-meta">
                      {i.key}: {i.error}
                    </p>
                  ))}
              </details>
            )}
          </div>
        ))}
    </details>
  );
}
export function StrictEvidence({
  projectId,
  report,
  act,
  onJump,
}: {
  projectId: string;
  report: StrictReport;
  act: Act;
  onJump: (file: string, line: number) => void;
}) {
  const [strict, setStrict] = useState(report.strict);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!saving) setStrict(report.strict);
  }, [report.strict, saving]);
  async function changePolicy(next: boolean) {
    setStrict(next);
    setSaving(true);
    const result = await act("Saving writing policy…", () =>
      api.research(projectId, "/policy", { strict: next }, "PUT"),
    );
    if (result === undefined) setStrict(report.strict);
    setSaving(false);
  }
  return (
    <div className="research-card">
      <div className="research-section-heading">
        <h3>Writing readiness</h3>
        <span>{report.open} passages open</span>
      </div>
      <label className="research-inline">
        <input
          type="checkbox"
          checked={strict}
          disabled={saving}
          onChange={(e) => void changePolicy(e.target.checked)}
        />
        Strict mode — resolve evidence gaps before approval
      </label>
      <p className="research-meta">
        Drafts remain editable. Opening a source alone does not verify a claim.
      </p>
      <button
        type="button"
        onClick={() =>
          void act("Scheduling uncited-claim audit…", () =>
            api.research(projectId, "/jobs", { kind: "strict-audit" }),
          )
        }
      >
        Check assertions without citations
      </button>
      <details className="research-meta">
        <summary>
          {report.ready ? "No unresolved passages" : "Review open passages"}
        </summary>
        {report.issues.map((issue) => (
          <ClaimDecision
            key={`${issue.id}:${issue.fingerprint}`}
            issue={issue}
            projectId={projectId}
            act={act}
            onJump={onJump}
          />
        ))}
        <p>{report.note}</p>
      </details>
    </div>
  );
}
function ClaimDecision({
  issue,
  projectId,
  act,
  onJump,
}: {
  issue: StrictReport["issues"][number];
  projectId: string;
  act: Act;
  onJump: (f: string, l: number) => void;
}) {
  const [reason, setReason] = useState(issue.decision?.reason ?? "");
  return (
    <div className="research-finding">
      <button
        type="button"
        className="research-link"
        onClick={() => onJump(issue.file, issue.line)}
      >
        {issue.file}:{issue.line}
        {issue.key ? ` · ${issue.key}` : " · no citation"}
      </button>
      <p className="research-claim">{issue.text}</p>
      <p>{issue.reason}</p>
      <label>
        Evidence or reason for your decision
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Link own results to data, or explain why external evidence is not required…"
        />
      </label>
      <button
        type="button"
        disabled={!issue.decision && reason.trim().length < 12}
        onClick={() =>
          void act("Saving your review…", () =>
            api.research(
              projectId,
              "/strict/decision",
              {
                id: issue.id,
                fingerprint: issue.fingerprint,
                reason,
                accept: !issue.decision,
              },
              "PUT",
            ),
          )
        }
      >
        {issue.decision
          ? "Reopen this passage"
          : "Accept with my recorded reason"}
      </button>
      {issue.decision && (
        <p className="research-meta">
          Accepted by you · {issue.decision.reason}
        </p>
      )}
    </div>
  );
}
interface LibraryResults {
  results: {
    key: string;
    title: string;
    page: number;
    quote: string;
    basis: string;
  }[];
  total: number;
  nextOffset?: number;
  note: string;
  expanded: string[];
  coverage: LibraryStatus;
}
export function PaperLibrary({
  projectId,
  status,
  act,
  open,
}: {
  projectId: string;
  status: LibraryStatus;
  act: Act;
  open: (key: string, page: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [result, setResult] = useState<LibraryResults>();
  const sourceRevision = JSON.stringify(status.sources.map(s => [s.key, s.revision]));
  useEffect(() => setResult(undefined), [query, semantic, sourceRevision]);
  const find = (offset = 0) =>
    void act("Searching your papers…", async () => {
      const next = await api.research<LibraryResults>(
        projectId,
        "/library/search",
        { query, semantic, offset },
      );
      setResult(next);
    });
  return (
    <>
      <div className="research-section-heading">
        <h3>Search your papers</h3>
        <span>
          {status.indexed} full texts · {status.abstractOnly} abstracts
        </span>
      </div>
      <p className="research-intro">
        Search extracted text across your sources, with passages you can open on
        the original page.
      </p>
      <div className="research-actions">
        <button
          type="button"
          disabled={!status.pending.length}
          onClick={() =>
            void act("Scheduling full-text indexing…", () =>
              api.research(projectId, "/jobs", { kind: "library-index" }),
            )
          }
        >
          Index missing & changed sources
          {status.pending.length ? ` (${status.pending.length})` : ""}
        </button>
        <button
          type="button"
          disabled={!status.sources.length}
          onClick={() =>
            void act("Refreshing source index…", () =>
              api.research(projectId, "/jobs", {
                kind: "library-index",
                keys: status.sources.map((s) => s.key),
              }),
            )
          }
        >
          Refresh all
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <label>
          Search the paper library
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Method, dataset, finding or question…"
            maxLength={1000}
          />
        </label>
        <label className="research-inline">
          <input
            type="checkbox"
            checked={semantic}
            onChange={(e) => setSemantic(e.target.checked)}
          />
          Include synonyms and translations using the model
        </label>
        <button
          className="research-primary"
          type="submit"
          disabled={!query.trim()}
        >
          Search papers
        </button>
      </form>
      {result && (
        <>
          <p className="research-meta">
            {result.total} passages · {result.note}
          </p>
          {!!result.expanded.length && (
            <p className="research-meta">
              Also searched: {result.expanded.join(", ")}
            </p>
          )}
          {result.results.map((hit, i) => (
            <article
              className="research-card"
              key={`${hit.key}:${hit.page}:${i}`}
            >
              <h3>{hit.title}</h3>
              <p className="research-meta">
                {hit.key} ·{" "}
                {hit.basis === "abstract"
                  ? "Abstract only"
                  : `PDF page ${hit.page}`}
              </p>
              <blockquote>{hit.quote}</blockquote>
              <button
                type="button"
                className="research-link"
                onClick={() => open(hit.key, hit.page)}
              >
                Open source · page {hit.page}
              </button>
            </article>
          ))}
          {result.nextOffset !== undefined && (
            <button type="button" onClick={() => find(result.nextOffset)}>
              Next passages
            </button>
          )}
        </>
      )}
      <details className="research-card">
        <summary>Source coverage · {status.sources.length} papers</summary>
        {status.sources.map((s) => (
          <div key={s.key} className="research-finding">
            <strong>{s.key}</strong> · {s.status}
            <p>{s.title}</p>
            {!!s.emptyPages.length && (
              <p className="research-meta">
                No text on pages {s.emptyPages.join(", ")}
              </p>
            )}
            {s.limitations.map((l, i) => (
              <p key={i} className="research-meta">
                {l}
              </p>
            ))}
          </div>
        ))}
      </details>
    </>
  );
}
type Verdict =
  | "supported"
  | "partially_supported"
  | "not_supported"
  | "unclear";
interface EvalCase {
  id: string;
  hash: string;
  title: string;
  url: string;
  excerpt: string;
  claim: string;
  expected: Verdict;
  rationale: string;
  location: string;
  review?: { expected: Verdict; reason: string };
}
interface EvalData {
  cases: EvalCase[];
  reviewed: number;
  note: string;
  groups: {
    name: string;
    reviewed: number;
    evaluated: number;
    accuracy: number | null;
    falseSupportRate: number | null;
    results: { caseId: string; verdict: string; explanation: string }[];
  }[];
}
export function QualityChecks({
  projectId,
  act,
  stamp,
}: {
  projectId: string;
  act: Act;
  stamp: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<EvalData>();
  const [error, setError] = useState("");
  const [importText, setImportText] = useState("");
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.research<EvalData>(projectId, "/evaluation").then(
      (d) => {
        if (!cancelled) setData(d);
      },
      (e) => {
        if (!cancelled) setError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, expanded, stamp]);
  return (
    <details
      className="research-card"
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>Scientific quality benchmark</summary>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>{data.note}</p>
          <p>
            {data.reviewed}/{data.cases.length} reference judgments reviewed by
            you
          </p>
          <button
            type="button"
            onClick={() =>
              void act("Scheduling quality evaluation…", () =>
                api.research(projectId, "/jobs", {
                  kind: "evaluation",
                  keys: data.cases.map((c) => c.id),
                }),
              )
            }
          >
            Run benchmark with selected model
          </button>
          <button type="button" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "scientific-quality-report.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Export benchmark report</button>
          {data.groups.map((g) => (
            <div className="research-finding" key={g.name}>
              <h4>{g.name}</h4>
              <p>
                {g.evaluated} evaluated · {g.reviewed} human-reviewed reference
                cases
              </p>
              <p>
                Agreement:{" "}
                {g.accuracy === null
                  ? "Awaiting reviewed labels"
                  : `${Math.round(g.accuracy * 100)}%`}{" "}
                · False support:{" "}
                {g.falseSupportRate === null
                  ? "Not available"
                  : `${Math.round(g.falseSupportRate * 100)}%`}
              </p>
              <details>
                <summary>Model judgments</summary>
                {g.results.map((r) => (
                  <p key={r.caseId}>
                    <strong>
                      {r.caseId}: {r.verdict}
                    </strong>{" "}
                    · {r.explanation}
                  </p>
                ))}
              </details>
            </div>
          ))}
          <details>
            <summary>Review reference cases</summary>
            {data.cases.map((c) => (
              <EvaluationReview
                key={`${c.id}:${c.hash}`}
                item={c}
                save={async (body) => {
                  const next = await act("Saving reference judgment…", () =>
                    api.research<EvalData>(
                      projectId,
                      "/evaluation/review",
                      body,
                      "PUT",
                    ),
                  );
                  if (next) setData(next);
                }}
              />
            ))}
          </details>
          <details className="research-meta">
            <summary>Import an annotated dataset</summary>
            <p>
              JSON array with id, title, url, location, excerpt, claim,
              expected, rationale and category. Imported labels also require
              your review.
            </p>
            <textarea
              rows={4}
              aria-label="Evaluation dataset JSON"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={() =>
                void act("Importing evaluation cases…", async () => {
                  const next = await api.research<EvalData>(
                    projectId,
                    "/evaluation/cases",
                    { cases: JSON.parse(importText) },
                    "PUT",
                  );
                  setData(next);
                })
              }
            >
              Import reference cases
            </button>
          </details>
        </>
      )}
    </details>
  );
}
function EvaluationReview({
  item,
  save,
}: {
  item: EvalCase;
  save: (body: object) => Promise<void>;
}) {
  const [expected, setExpected] = useState(
    item.review?.expected ?? item.expected,
  );
  const [reason, setReason] = useState(item.review?.reason ?? "");
  return (
    <div className="research-finding">
      <a href={item.url} target="_blank" rel="noreferrer">
        {item.title} ↗
      </a>
      <p className="research-meta">{item.location}</p>
      <blockquote>{item.excerpt}</blockquote>
      <p>
        <strong>Claim:</strong> {item.claim}
      </p>
      <p className="research-meta">Proposed rationale: {item.rationale}</p>
      <label>
        Your reference judgment
        <select
          value={expected}
          onChange={(e) => setExpected(e.target.value as Verdict)}
        >
          {["supported", "partially_supported", "not_supported", "unclear"].map(
            (v) => (
              <option value={v} key={v}>
                {v.replaceAll("_", " ")}
              </option>
            ),
          )}
        </select>
      </label>
      <label>
        Your review reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={reason.trim().length < 12}
        onClick={() =>
          void save({ id: item.id, hash: item.hash, expected, reason })
        }
      >
        {item.review ? "Update my judgment" : "Confirm my reference judgment"}
      </button>
    </div>
  );
}
