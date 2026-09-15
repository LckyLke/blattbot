import { appUrl } from "../urls";
import { CodeChecks } from "./CodeRepositories";
import {
  PaperLibrary,
  QualityChecks,
  ResearchTasks,
  StrictEvidence,
} from "./ResearchExtras";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api";
import {
  memoryLabels,
  type Evidence,
  type Memory,
  type MemoryFields,
  type Quote,
  type ResearchData,
  type ReviewIssue,
  type SearchHit,
  type SearchRun,
  type SourcePage,
  type SourceVersion,
  type ZoteroConfig,
  type ZoteroImport,
  type ZoteroResults,
} from "../research";
import "./research.css";
import CitationGraph from "./CitationGraph";

type Action = <T>(
  label: string,
  task: () => Promise<T>,
) => Promise<T | undefined>;
interface Props {
  projectId: string;
  stamp: number;
  busy: boolean;
  onJump: (file: string, line: number) => void;
  onCodeAudit?: (focus: string) => void;
}
const labels: Record<string, string> = {
  unchecked: "Not checked",
  stale: "Changed · check again",
  supported: "Supports claim",
  partially_supported: "Partial support",
  not_supported: "Does not support claim",
  unclear: "Insufficient evidence",
  full_text: "PDF text",
  abstract: "Abstract only",
  none: "Source missing",
  not_flagged: "No indexed flag",
  unavailable: "Check unavailable",
  retracted: "Retraction flagged",
  updated: "Update flagged",
};
const date = (value: string) =>
  value ? new Date(value).toLocaleString() : "Not saved yet";
function Badge({ value }: { value: string }) {
  return (
    <span className={`research-badge research-${value}`}>
      {labels[value] ?? value.replaceAll("_", " ")}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="research-empty">{children}</p>;
}
function SourceMeta({
  source,
  limited,
}: {
  source: SourceVersion;
  limited: boolean;
}) {
  return (
    <details className="research-meta">
      <summary>
        <Badge value={source.basis} />{" "}
        {limited ? "Limited source coverage" : "Source snapshot"} ·{" "}
        {date(source.at)}
      </summary>
      <p>{source.title}</p>
      <p className="research-path">{source.source}</p>
      <p>
        Text version: {source.textHash.slice(0, 12)}
        {source.fileHash && ` · PDF version: ${source.fileHash.slice(0, 12)}`}
      </p>
    </details>
  );
}
function Quotes({
  quotes,
  sourceKey,
  open,
}: {
  quotes: Quote[];
  sourceKey: string;
  open: (key: string, page: number) => void;
}) {
  return (
    <>
      {quotes.map((q, i) => (
        <blockquote key={i}>
          <p>{q.quote}</p>
          <button
            type="button"
            className="research-link"
            onClick={() => open(sourceKey, q.page)}
          >
            Open source · page {q.page}
          </button>
        </blockquote>
      ))}
    </>
  );
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ResearchPanel({
  projectId,
  stamp,
  busy,
  onJump,
  onCodeAudit,
}: Props) {
  const [data, setData] = useState<ResearchData>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState("graph");
  const [evidenceFilter, setEvidenceFilter] = useState("all");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState<SourcePage>();
  const [showImage, setShowImage] = useState(false);
  const [imageError, setImageError] = useState(false);
  const alive = useRef(true);
  const operation = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [tab]);
  const load = useCallback(async () => {
    const seq = ++generation.current;
    const next = await api.research<ResearchData>(projectId);
    if (alive.current && seq === generation.current) {
      setData(next);
      setRefreshVersion((v) => v + 1);
    }
  }, [projectId]);
  useEffect(() => {
    load().catch((err) => {
      if (alive.current) setError(err.message);
    });
  }, [load, stamp]);
  const hasRunningJobs = data?.jobs.some((job) =>
    ["queued", "running"].includes(job.state),
  );
  useEffect(() => {
    if (!hasRunningJobs) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 1600);
    return () => clearInterval(timer);
  }, [hasRunningJobs, load]);
  const act: Action = async (label, task) => {
    if (operation.current) return undefined;
    operation.current = true;
    setWorking(label);
    setError("");
    setNotice("");
    try {
      const result = await task();
      if (!alive.current) return undefined;
      await load();
      return result;
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      operation.current = false;
      if (alive.current) setWorking("");
    }
  };
  const open = (key: string, page: number) => {
    void act("Opening source…", async () => {
      const result = await api.research<SourcePage>(
        projectId,
        `/source/${encodeURIComponent(key)}/${page}`,
      );
      if (alive.current) {
        setSource(result);
        setShowImage(false);
        setImageError(false);
      }
    });
  };
  const tabs = [
    ["graph", "Graph"],
    ["evidence", "Evidence"],
    ["library", "Library"],
    ["checks", "Checks"],
    ["memory", "Memory"],
    ["discover", "Discover"],
  ];
  return (
    <div className="research-panel" ref={panel}>
      <div className="research-shell">
        <header className="research-heading">
          <div>
            <h2>Research</h2>
            <p>Your sources, evidence and writing.</p>
          </div>
          <button
            type="button"
            disabled={!!working}
            aria-label="Refresh research"
            title="Refresh research"
            className="research-icon-button"
            onClick={() => void act("Refreshing…", async () => {})}
          >
            ↻
          </button>
        </header>
        <nav className="research-tabs" aria-label="Research views">
          {tabs.map(([key, title]) => (
            <button
              type="button"
              key={key}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {title}
            </button>
          ))}
        </nav>
      </div>
      {error && (
        <p className="research-alert" role="alert">
          {error}
        </p>
      )}
      {working && (
        <p className="research-progress" role="status">
          {working} Reading and model checks can take a few minutes.
        </p>
      )}
      {notice && (
        <p className="research-notice" role="status">
          {notice}
        </p>
      )}
      {data && (
        <ResearchTasks
          key={tab}
          projectId={projectId}
          jobs={data.jobs.filter((job) => {
            if (job.kind === "library-index") return tab === "library";
            if (["evidence", "strict-audit"].includes(job.kind))
              return tab === "evidence";
            if (["matrix", "outline"].includes(job.kind))
              return false;
            return tab === "checks";
          })}
          onChanged={load}
        />
      )}
      {!data ? (
        <Empty>Loading research workspace…</Empty>
      ) : (
        <fieldset className="research-body" disabled={!!working}>
          {tab === "library" && (
            <PaperLibrary
              projectId={projectId}
              status={data.library}
              act={act}
              open={open}
            />
          )}
          {tab === "evidence" && (
            <>
              <StrictEvidence
                projectId={projectId}
                report={data.strict}
                act={act}
                onJump={onJump}
              />
              <div className="research-section-heading">
                <h3>Claim evidence</h3>
                <span>{data.evidence.length} passages</span>
              </div>
              <p className="research-intro">
                Review the evidence behind each cited passage.
              </p>
              <div className="research-actions">
                <button
                  type="button"
                  className="research-primary"
                  disabled={
                    !data.evidence.some((e) =>
                      ["unchecked", "stale"].includes(e.status),
                    )
                  }
                  onClick={() =>
                    void act("Scheduling evidence checks…", () =>
                      api.research(projectId, "/jobs", { kind: "evidence" }),
                    )
                  }
                >
                  Check new & changed passages
                </button>
              </div>
              {!data.evidence.length && (
                <Empty>
                  Cite a paper in your manuscript to start. Add sources in
                  References or Discover.
                </Empty>
              )}
              <label className="research-filter">
                Show
                <select
                  value={evidenceFilter}
                  onChange={(e) => setEvidenceFilter(e.target.value)}
                >
                  <option value="all">All passages</option>
                  <option value="attention">Needs attention</option>
                  <option value="supported">Supported</option>
                </select>
              </label>
              {data.evidence
                .filter(
                  (e) =>
                    evidenceFilter === "all" ||
                    (evidenceFilter === "supported"
                      ? e.status === "supported"
                      : e.status !== "supported"),
                )
                .map((e) => (
                  <EvidenceCard
                    key={e.id}
                    evidence={e}
                    open={open}
                    onJump={onJump}
                    verify={() =>
                      void act(`Checking ${e.key}…`, () =>
                        api.research(projectId, "/jobs", {
                          kind: "evidence",
                          keys: [e.id],
                        }),
                      )
                    }
                  />
                ))}
              <PaperReader
                projectId={projectId}
                refs={data.refs}
                act={act}
                open={open}
              />
            </>
          )}
          {tab === "checks" && (
            <><CodeChecks projectId={projectId} stamp={stamp} busy={busy} onAudit={onCodeAudit} onJump={onJump} /><Checks
              projectId={projectId}
              data={data}
              act={act}
              onJump={onJump}
            /></>
          )}
          {tab === "memory" && (
            <MemoryEditor
              key={data.memory.revision}
              memory={data.memory}
              save={(fields) =>
                void act("Saving project memory…", () =>
                  api.research(
                    projectId,
                    "/memory",
                    { fields, revision: data.memory.revision },
                    "PUT",
                  ),
                )
              }
            />
          )}
          {tab === "graph" && (
            <CitationGraph
              onJump={onJump}
              projectId={projectId}
              busy={busy}
              stamp={refreshVersion}
            />
          )}
          {tab === "discover" && (
            <Discover
              projectId={projectId}
              data={data}
              act={act}
              busy={busy}
              notify={setNotice}
            />
          )}
        </fieldset>
      )}
      {source && (
        <section
          className="research-source"
          aria-label="Original source passage"
        >
          <div className="research-actions">
            <h3>
              {source.key} ·{" "}
              {source.basis === "abstract"
                ? "Abstract"
                : `PDF page ${source.page}`}
            </h3>
            <button type="button" onClick={() => setSource(undefined)}>
              Close source
            </button>
          </div>
          <p>{source.title}</p>
          <pre>{source.text}</pre>
          {source.limitations.map((lim, i) => (
            <p className="research-meta" key={i}>
              {lim}
            </p>
          ))}
          {source.basis === "full_text" && (
            <button type="button" onClick={() => setShowImage(!showImage)}>
              {showImage ? "Hide" : "Show"} original page image
            </button>
          )}
          {showImage &&
            (imageError ? (
              <p role="alert">
                Page rendering failed. Check Poppler availability in Read a
                paper.
              </p>
            ) : (
              <img
                alt={`Original PDF page ${source.page} of ${source.title}`}
                src={appUrl(`/api/projects/${encodeURIComponent(projectId)}/research/page-image/${encodeURIComponent(source.key)}/${source.page}`)}
                onError={() => setImageError(true)}
              />
            ))}
        </section>
      )}
    </div>
  );
}

function EvidenceCard({
  evidence: e,
  open,
  onJump,
  verify,
}: {
  evidence: Evidence;
  open: (key: string, page: number) => void;
  onJump: Props["onJump"];
  verify: () => void;
}) {
  return (
    <article className="research-card">
      <div className="research-actions">
        <strong>{e.key}</strong>
        <Badge value={e.status} />
        <button type="button" onClick={verify}>
          {e.record ? "Recheck" : "Check evidence"}
        </button>
      </div>
      <p className="research-claim">{e.claim}</p>
      <button
        type="button"
        className="research-link"
        onClick={() => onJump(e.file, e.line)}
      >
        {e.file}:{e.line}
      </button>
      {e.record && (
        <details>
          <summary>Evidence & explanation</summary>
          {e.status === "stale" && (
            <p className="research-alert">
              This assessment describes an earlier claim or source version.
            </p>
          )}
          <p>{e.record.explanation}</p>
          <Quotes quotes={e.record.quotes} sourceKey={e.key} open={open} />
          <SourceMeta source={e.record.source} limited={e.record.limited} />
        </details>
      )}
    </article>
  );
}
function MemoryEditor({
  memory,
  save,
}: {
  memory: Memory;
  save: (fields: MemoryFields) => void;
}) {
  const [fields, setFields] = useState(memory.fields);
  const [restored, setRestored] = useState("");
  return (
    <>
      <p className="research-intro">
        Accepted project knowledge is included in every new chat turn. Model
        suggestions remain drafts until you save them.
      </p>
      <div className="research-actions">
        <Badge value={`Revision ${memory.revision}`} />
        <span>{date(memory.at)}</span>
      </div>
      {memory.proposal && (
        <details className="research-card">
          <summary>Suggested update · review before accepting</summary>
          <p>{memory.proposal.reason}</p>
          {Object.entries(memoryLabels).map(([key, label]) => (
            <div key={key}>
              <h4>{label}</h4>
              <p className="research-preserve">
                {memory.proposal!.fields[key as keyof MemoryFields] || "—"}
              </p>
            </div>
          ))}
          <button
            type="button"
            disabled={memory.proposal.baseRevision !== memory.revision}
            onClick={() => {
              setFields(memory.proposal!.fields);
              setRestored(
                "Suggestion loaded into the form. Review it, then save to accept.",
              );
            }}
          >
            Load suggestion for review
          </button>
        </details>
      )}
      {restored && <p className="research-notice">{restored}</p>}
      <div className="research-card">
        <div className="research-memory-grid">
          {Object.entries(memoryLabels).map(([key, label]) => (
            <label key={key}>
              {label}
              <textarea
                rows={3}
                maxLength={8000}
                value={fields[key as keyof MemoryFields]}
                onChange={(e) =>
                  setFields({ ...fields, [key]: e.target.value })
                }
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          className="research-primary"
          onClick={() => save(fields)}
        >
          Save accepted project memory
        </button>
      </div>
      <details className="research-card">
        <summary>
          Version history · {memory.history.length} earlier versions
        </summary>
        {[...memory.history].reverse().map((version) => (
          <div className="research-actions" key={version.revision}>
            <span>
              Revision {version.revision} · {date(version.at)}
            </span>
            <button
              type="button"
              onClick={() => {
                setFields(version.fields);
                setRestored(
                  `Revision ${version.revision} loaded. Save to restore it as a new version.`,
                );
              }}
            >
              Load this version
            </button>
          </div>
        ))}
      </details>
    </>
  );
}
function Checks({
  projectId,
  data,
  act,
  onJump,
}: {
  projectId: string;
  data: ResearchData;
  act: Action;
  onJump: Props["onJump"];
}) {
  const [context, setContext] = useState("");
  const [audit, setAudit] = useState("");
  return (
    <>
      <QualityChecks
        projectId={projectId}
        act={act}
        stamp={data.jobs
          .filter((j) => j.kind === "evaluation")
          .reduce(
            (n, j) => n + j.items.filter((i) => i.state !== "pending").length,
            0,
          )}
      />
      <div className="research-card">
        <h3>Citation keys & bibliography</h3>
        <details className="research-meta">
          <summary>What this checks</summary>
          <p>{data.bibliography.note}</p>
        </details>
        <div className="research-actions">
          <span>
            {data.bibliography.entries} entries ·{" "}
            {data.bibliography.issues.length} structural notices
          </span>
          <button
            type="button"
            onClick={() =>
              void act("Verifying publication identities…", async () => {
                const result = await api.auditRefs(projectId);
                setAudit(JSON.stringify(result, null, 2));
              })
            }
          >
            Verify references against indexes
          </button>
        </div>
        {!data.bibliography.issues.length && (
          <p>No key or metadata issues detected.</p>
        )}
        {data.bibliography.issues.map((issue, i) => (
          <div className="research-finding" key={i}>
            <strong>{issue.keys.join(", ")}</strong> ·{" "}
            <Badge value={issue.kind} />
            <p>{issue.detail}</p>
            {issue.files.map((file, j) => (
              <button
                className="research-link"
                key={`${file}:${j}`}
                type="button"
                onClick={() => onJump(file, 1)}
              >
                {file}
              </button>
            ))}
          </div>
        ))}
        <details>
          <summary>{data.bibliography.unusedKeys.length} uncited keys</summary>
          <p>{data.bibliography.unusedKeys.join(", ") || "None"}</p>
        </details>
        {audit && <pre>{audit}</pre>}
      </div>
      <div className="research-card">
        <h3>Scientific consistency</h3>
        <p>
          Check conclusions, numbers, experimental comparisons, causal language
          and definitions. Findings point to actual text passages.
        </p>
        <label>
          Additional data or code files to inspect (one attached or project path
          per line)
          <textarea
            value={context}
            rows={3}
            onChange={(e) => setContext(e.target.value)}
            placeholder="results/metrics.csv"
          />
        </label>
        <button
          type="button"
          className="research-primary"
          onClick={() =>
            void act("Reviewing manuscript and selected context…", () =>
              api.research(projectId, "/jobs", {
                kind: "review",
                context: context
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              }),
            )
          }
        >
          Review manuscript
        </button>
      </div>
      {data.review && (
        <>
          <div className="research-card">
            <div className="research-actions">
              <Badge value={data.review.stale ? "stale" : "Review snapshot"} />
              <span>{date(data.review.at)}</span>
            </div>
            <p>{data.review.coverage}</p>
            {data.review.limited && (
              <p className="research-alert">
                Only part of the selected content fitted in this review.
              </p>
            )}
            <details>
              <summary>Inspected files · {data.review.inputs.length}</summary>
              {data.review.inputs.map((input) => (
                <p className="research-path" key={input.path}>
                  {input.path} · {input.charsRead.toLocaleString()} characters ·
                  version {input.hash.slice(0, 10)}
                </p>
              ))}
            </details>
            {!data.review.issues.length && (
              <p>
                No source-locatable findings were returned. This does not
                establish scientific correctness.
              </p>
            )}
          </div>
          {data.review.issues.map((issue) => (
            <ReviewCard
              key={`${data.review!.at}:${issue.id}`}
              issue={issue}
              stale={!!data.review!.stale}
              onJump={onJump}
              save={(resolved, note) =>
                void act("Saving review decision…", () =>
                  api.research(
                    projectId,
                    "/review/issue",
                    { id: issue.id, resolved, note, at: data.review!.at },
                    "PUT",
                  ),
                )
              }
            />
          ))}
        </>
      )}
    </>
  );
}
function ReviewCard({
  issue,
  stale,
  onJump,
  save,
}: {
  issue: ReviewIssue;
  stale: boolean;
  onJump: Props["onJump"];
  save: (resolved: boolean, note: string) => void;
}) {
  const [note, setNote] = useState(issue.note);
  return (
    <article className="research-card">
      <div className="research-actions">
        <Badge value={issue.category} />
        <Badge value={issue.severity} />
        {issue.resolved && <Badge value="Reviewed / resolved" />}
      </div>
      <p>{issue.explanation}</p>
      {issue.locations.map((location, i) => (
        <blockquote key={i}>
          <p>{location.quote}</p>
          <button
            type="button"
            className="research-link"
            onClick={() => onJump(location.file, location.line)}
          >
            {location.file}:{location.line}
          </button>
        </blockquote>
      ))}
      <p>
        <strong>Suggested action:</strong> {issue.suggestion}
      </p>
      <label>
        Your decision
        <textarea
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="research-actions">
        <button
          type="button"
          disabled={stale}
          onClick={() => save(!issue.resolved, note)}
        >
          {issue.resolved ? "Reopen" : "Mark resolved"}
        </button>
        <button
          type="button"
          disabled={stale}
          onClick={() => save(issue.resolved, note)}
        >
          Save note
        </button>
      </div>
    </article>
  );
}
function PaperReader({
  projectId,
  refs,
  act,
  open,
}: {
  projectId: string;
  refs: ResearchData["refs"];
  act: Action;
  open: (key: string, page: number) => void;
}) {
  const [key, setKey] = useState("");
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [offset, setOffset] = useState(0);
  const [text, setText] = useState("");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [resultKey, setResultKey] = useState("");
  const [caps, setCaps] = useState<{
    render: boolean;
    ocr: boolean;
    note: string;
  }>();
  const selected = key || refs[0]?.key || "";
  useEffect(() => {
    let live = true;
    api
      .research<{ render: boolean; ocr: boolean; note: string }>(
        projectId,
        "/capabilities",
      )
      .then((value) => {
        if (live) setCaps(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);
  const read = (ocr = false) =>
    void act(ocr ? "Recognizing page text…" : "Reading paper…", async () => {
      const result = await api.research<{ text: string }>(projectId, "/read", {
        key: selected,
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(query.trim() ? { query } : {}),
        offset,
        ocr,
        page,
      });
      setText(result.text);
      setQuotes([]);
    });
  return (
    <details className="research-card">
      <summary>Read a paper · text, OCR, figures & semantic search</summary>
      <label>
        Paper
        <select
          value={selected}
          onChange={(e) => {
            setKey(e.target.value);
            setOffset(0);
          }}
        >
          {refs.map((ref) => (
            <option key={ref.key} value={ref.key}>
              {ref.key} · {ref.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Optional local PDF path (attach it under External context first)
        <input value={path} onChange={(e) => setPath(e.target.value)} />
      </label>
      <label>
        Question or search phrase
        <input
          value={query}
          maxLength={1000}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <div className="research-columns">
        <label>
          PDF page
          <input
            type="number"
            min={1}
            max={1000}
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
          />
        </label>
        <label>
          Text offset (for continued reads)
          <input
            type="number"
            min={0}
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="research-actions">
        <button type="button" disabled={!selected} onClick={() => read()}>
          Read / exact search
        </button>
        <button
          type="button"
          disabled={!selected || !caps?.ocr}
          onClick={() => read(true)}
        >
          OCR selected page
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => open(selected, page)}
        >
          Open source page
        </button>
        <button
          type="button"
          disabled={!selected || !query.trim()}
          onClick={() =>
            void act("Searching by meaning…", async () => {
              const result = await api.research<{
                explanation: string;
                quotes: Quote[];
                basis: string;
                limited: boolean;
                discardedQuotes: number;
              }>(projectId, "/semantic-search", { key: selected, query });
              setResultKey(selected);
              setQuotes(result.quotes);
              setText(
                `${result.explanation}\nSource: ${labels[result.basis] ?? result.basis}${result.limited ? " · selected excerpts only" : ""}${result.discardedQuotes ? " · Unlocatable proposed quotes were discarded." : ""}`,
              );
            })
          }
        >
          Search by meaning
        </button>
        <button
          type="button"
          disabled={!selected || !query.trim() || !caps?.render}
          onClick={() =>
            void act("Inspecting page image…", async () => {
              const result = await api.research<{
                interpretation: string;
                limitation: string;
              }>(projectId, "/inspect-page", {
                key: selected,
                page,
                question: query,
              });
              setQuotes([]);
              setText(`${result.interpretation}\n\n${result.limitation}`);
            })
          }
        >
          Inspect figure / table
        </button>
      </div>
      <p className="research-meta">
        {caps
          ? `Page images: ${caps.render ? "available" : "needs Poppler"}. OCR: ${caps.ocr ? "available" : "needs Poppler + Tesseract"}. ${caps.note}`
          : "Checking reading capabilities…"}{" "}
        Read with the local path once to bind a supplied PDF to its citation
        key.
      </p>
      {text && <pre>{text}</pre>}
      <Quotes quotes={quotes} sourceKey={resultKey} open={open} />
    </details>
  );
}
function Discover({
  projectId,
  data,
  act,
  busy,
  notify,
}: {
  projectId: string;
  data: ResearchData;
  act: Action;
  busy: boolean;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [criteria, setCriteria] = useState("");
  const [key, setKey] = useState("");
  const [runId, setRunId] = useState("");
  const selected = key || data.refs[0]?.key || "";
  const run =
    data.searches.find((run) => run.id === runId) ?? data.searches.at(-1);
  const doSearch = () =>
    void act("Searching literature…", async () => {
      const result = await api.research<SearchRun>(projectId, "/search", {
        query,
        criteria,
        limit: 20,
      });
      setRunId(result.id);
    });
  const neighbors = (
    direction: "references" | "citing",
    cursor?: string,
    sourceKey = selected,
  ) =>
    void act("Following citation links…", async () => {
      const result = await api.research<SearchRun>(projectId, "/neighbors", {
        key: sourceKey,
        direction,
        cursor,
      });
      setRunId(result.id);
    });
  return (
    <>
      <div className="research-card">
        <h3>Literature search</h3>
        <label>
          Search query
          <input
            value={query}
            maxLength={1000}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Selection criteria
          <textarea
            value={criteria}
            maxLength={4000}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="Scope, methods, year range, inclusion and exclusion criteria…"
          />
        </label>
        <button
          type="button"
          className="research-primary"
          disabled={!query.trim()}
          onClick={doSearch}
        >
          Search & record results
        </button>
        <p className="research-meta">
          Every run saves the query, date, returned results and screening
          decisions. Index coverage is incomplete.
        </p>
      </div>
      <div className="research-card">
        <h3>Citation connections & publication status</h3>
        <label>
          Starting paper
          <select value={selected} onChange={(e) => setKey(e.target.value)}>
            {data.refs.map((ref) => (
              <option key={ref.key} value={ref.key}>
                {ref.key} · {ref.title}
              </option>
            ))}
          </select>
        </label>
        <div className="research-actions">
          <button
            type="button"
            disabled={!selected}
            onClick={() => neighbors("references")}
          >
            Find its references
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => neighbors("citing")}
          >
            Find papers citing it
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() =>
              void act("Checking corrections and retractions…", () =>
                api.research(projectId, "/publication-status", {
                  key: selected,
                }),
              )
            }
          >
            Check publication status
          </button>
        </div>
        {data.publicationStatus[selected] && (
          <div className="research-finding">
            <Badge
              value={
                data.publicationStatus[selected].stale
                  ? "stale"
                  : data.publicationStatus[selected].status
              }
            />
            <p>{data.publicationStatus[selected].note}</p>
            <p className="research-meta">
              {date(data.publicationStatus[selected].at)}
            </p>
            {data.publicationStatus[selected].notices.map((n, i) => (
              <p key={i}>
                {n.type} · {n.source}{" "}
                {n.doi && (
                  <a
                    href={`https://doi.org/${encodeURIComponent(n.doi)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Publisher notice
                  </a>
                )}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="research-card">
        <h3>Search history & screening</h3>
        <label>
          Saved run
          <select
            value={run?.id ?? ""}
            onChange={(e) => setRunId(e.target.value)}
          >
            {[...data.searches].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                {date(r.at)} · {r.kind} · {r.query}
              </option>
            ))}
          </select>
        </label>
        {!run && (
          <Empty>Start a search to build a traceable reading list.</Empty>
        )}
        {run && (
          <>
            <p>{run.criteria}</p>
            <p>
              {run.results.length} results in this run
              {run.total !== undefined && ` · ${run.total} indexed in total`}
            </p>
            {run.error && (
              <p className="research-alert" role="alert">
                {run.error}
              </p>
            )}
            {run.results.map((hit, i) => (
              <ScreenHit
                key={`${run.id}:${hit.ref}:${i}`}
                hit={hit}
                decision={run.decisions[hit.ref]}
                disabled={busy}
                save={(decision, reason) =>
                  void act("Saving screening decision…", () =>
                    api.research(
                      projectId,
                      "/screen",
                      { runId: run.id, ref: hit.ref, decision, reason },
                      "PUT",
                    ),
                  )
                }
                add={() =>
                  void act("Adding verified reference…", async () => {
                    const result = await api.research<{
                      key: string;
                      status: string;
                      verification?: { status: string; detail?: string };
                    }>(projectId, "/add-reference", { ref: hit.ref });
                    notify(
                      `${result.key}: ${result.status}. Identity check: ${result.verification?.status ?? "unavailable"}. ${result.verification?.detail ?? ""}`,
                    );
                  })
                }
              />
            ))}
            {run.cursor && run.kind !== "search" && (
              <button
                type="button"
                onClick={() =>
                  neighbors(
                    run.kind as "references" | "citing",
                    run.cursor,
                    run.query,
                  )
                }
              >
                Get next page of citation links
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                download(
                  "search-history.md",
                  data.searches
                    .map(
                      (r) =>
                        `## ${r.query}\n${r.at} · ${r.kind}\nCriteria: ${r.criteria}\n${r.error ?? ""}\n` +
                        r.results
                          .map(
                            (h) =>
                              `- ${h.title} (${h.ref}) — ${r.decisions[h.ref]?.decision ?? "pending"}: ${r.decisions[h.ref]?.reason ?? ""}`,
                          )
                          .join("\n"),
                    )
                    .join("\n\n"),
                )
              }
            >
              Export search log
            </button>
          </>
        )}
      </div>
      <Zotero
        projectId={projectId}
        config={data.zotero}
        imports={data.zoteroImports}
        act={act}
        busy={busy}
        notify={notify}
      />
    </>
  );
}
function ScreenHit({
  hit,
  decision,
  disabled,
  save,
  add,
}: {
  hit: SearchHit;
  decision?: { decision: string; reason: string };
  disabled: boolean;
  save: (decision: string, reason: string) => void;
  add: () => void;
}) {
  const [state, setState] = useState(decision?.decision ?? "pending");
  const [reason, setReason] = useState(decision?.reason ?? "");
  return (
    <article className="research-finding">
      <h4>{hit.title}</h4>
      <p>
        {hit.authors} · {hit.year} · {hit.source}
      </p>
      <p className="research-meta">{hit.ref}</p>
      <div className="research-columns">
        <label>
          Decision
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
        </label>
        <label>
          Reason
          <input
            value={reason}
            maxLength={4000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <div className="research-actions">
        <button type="button" onClick={() => save(state, reason)}>
          Save decision
        </button>
        <button
          type="button"
          disabled={disabled || hit.ref.startsWith("openalex:")}
          onClick={add}
        >
          Add to bibliography
        </button>
      </div>
      {hit.ref.startsWith("openalex:") && (
        <p className="research-meta">
          No importable identifier supplied by this index. Find a DOI, arXiv or
          DBLP record first.
        </p>
      )}
    </article>
  );
}
function Zotero({
  projectId,
  config,
  imports,
  act,
  busy,
  notify,
}: {
  projectId: string;
  config: ZoteroConfig;
  imports: Record<string, ZoteroImport>;
  act: Action;
  busy: boolean;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState(config.mode);
  const [libraryType, setLibraryType] = useState(config.libraryType);
  const [libraryId, setLibraryId] = useState(config.libraryId);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ZoteroResults>();
  const dirty =
    mode !== config.mode ||
    libraryType !== config.libraryType ||
    libraryId !== config.libraryId ||
    !!apiKey;
  const search = (start = 0) =>
    void act("Reading Zotero library…", async () => {
      const result = await api.research<ZoteroResults>(
        projectId,
        "/zotero/search",
        { query, start },
      );
      setResults(result);
    });
  return (
    <details className="research-card">
      <summary>Zotero library · import references, PDFs & notes</summary>
      <p>
        Read from Zotero on this computer or from a web library. Your Zotero
        library is not modified.
      </p>
      <label>
        Connection
        <select
          value={mode}
          onChange={(e) => {
            const next = e.target.value as "local" | "web";
            setMode(next);
            if (next === "local") {
              setLibraryId("0");
              setLibraryType("users");
            }
          }}
        >
          <option value="local">Local Zotero</option>
          <option value="web">Zotero web API</option>
        </select>
      </label>
      <div className="research-columns">
        <label>
          Library type
          <select
            value={libraryType}
            onChange={(e) =>
              setLibraryType(e.target.value as "users" | "groups")
            }
          >
            <option value="users">User library</option>
            <option value="groups">Group library</option>
          </select>
        </label>
        <label>
          Numeric library ID
          <input
            value={libraryId}
            inputMode="numeric"
            onChange={(e) => setLibraryId(e.target.value)}
          />
        </label>
      </div>
      {mode === "web" && (
        <label>
          API key (read access)
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              config.hasApiKey
                ? "Saved key · leave blank to keep"
                : "For private libraries"
            }
          />
        </label>
      )}
      <p className="research-meta">
        {mode === "local"
          ? "Open Zotero and enable Settings → Advanced → Allow other applications on this computer to communicate with Zotero. The local user library normally uses ID 0."
          : "Use your numeric Zotero user/group ID. The key is stored locally and is never sent to the writing model."}
      </p>
      <button
        type="button"
        disabled={!/^\d+$/.test(libraryId)}
        onClick={() =>
          void act("Saving Zotero connection…", async () => {
            await api.research(
              projectId,
              "/zotero",
              { mode, libraryType, libraryId, ...(apiKey ? { apiKey } : {}) },
              "PUT",
            );
            setApiKey("");
            setResults(undefined);
            notify("Zotero connection settings saved.");
          })
        }
      >
        Save connection
      </button>
      <label>
        Find in Zotero
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button type="button" disabled={dirty} onClick={() => search()}>
        Read library
      </button>
      {dirty && (
        <p className="research-meta">
          Save connection changes before reading or importing.
        </p>
      )}
      {results?.items.map((item) => (
        <article className="research-finding" key={item.key}>
          <h4>{item.title}</h4>
          <p>
            {item.author} · {item.year}
          </p>
          <button
            type="button"
            disabled={busy || dirty}
            onClick={() =>
              void act(`Importing ${item.title}…`, async () => {
                const result = await api.research<ZoteroImport>(
                  projectId,
                  "/zotero/import",
                  { itemKey: item.key },
                );
                notify(
                  `Imported as ${result.citeKey}. ${result.warnings.join(" ")}`,
                );
              })
            }
          >
            Import reference & attachments
          </button>
          {imports[item.key] && (
            <p className="research-meta">
              Imported as {imports[item.key].citeKey} ·{" "}
              {date(imports[item.key].at)}
              {imports[item.key].pdfPath && " · PDF attached"}
              {imports[item.key].notesPath && " · Notes attached as text"}
              {imports[item.key].warnings
                .map((warning) => ` · ${warning}`)
                .join("")}
            </p>
          )}
        </article>
      ))}
      {results && !results.items.length && (
        <Empty>No matching Zotero entries.</Empty>
      )}
      {results?.next !== undefined && (
        <button
          type="button"
          disabled={dirty}
          onClick={() => search(results.next)}
        >
          Next library page
        </button>
      )}
    </details>
  );
}
