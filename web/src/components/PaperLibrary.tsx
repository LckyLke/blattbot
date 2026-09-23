import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { LibraryStatus, ResearchJob } from "../research";
import { ResearchTasks } from "./LibraryTasks";

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const wanted = new Set(terms.map((t) => t.normalize("NFKC").toLowerCase()));
  return (
    <>
      {text
        .split(/([\p{L}\p{N}]+)/u)
        .map((part, i) =>
          wanted.has(part.normalize("NFKC").toLowerCase()) ? (
            <mark key={i}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}
interface Hit {
  key: string;
  title: string;
  page: number;
  offset: number;
  quote: string;
  basis: string;
  section: string;
  matchedTerms: string[];
}
interface Results {
  results: Hit[];
  total: number;
  sourceCount: number;
  nextOffset?: number;
  expanded: string[];
  excludedReferences: number;
}
const statusLabel: Record<string, string> = {
  indexed: "Full text",
  abstract: "Abstract only",
  summary: "Summary only",
  missing: "Text unavailable",
  stale: "Updating text",
};
export default function PaperLibrary({
  projectId,
  stamp,
  initialKey,
  open,
  onOpenGraph,
  onRead,
}: {
  projectId: string;
  stamp: number;
  initialKey?: string;
  open: (key: string, page: number, terms?: string[]) => void;
  onOpenGraph: (key: string) => void;
  onRead?: (key: string, page?: number) => void;
}) {
  const [data, setData] = useState<{
    library: LibraryStatus;
    jobs: ResearchJob[];
  }>();
  const [query, setQuery] = useState("");
  const [key, setKey] = useState(initialKey ?? "");
  const [match, setMatch] = useState("all");
  const [semantic, setSemantic] = useState(false);
  const [includeReferences, setIncludeReferences] = useState(false);
  const [result, setResult] = useState<Results>();
  const [working, setWorking] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const load = async () => {
    const version = ++loadVersion.current;
    const next = await api.research<{
      library: LibraryStatus;
      jobs: ResearchJob[];
    }>(projectId);
    if (alive.current && version === loadVersion.current) setData(next);
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => {
      if (alive.current) setError(e.message);
    });
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => {
      alive.current = false;
      loadVersion.current++;
      sequence.current++;
      clearInterval(timer);
    };
  }, [projectId, stamp]);
  const sourceRevision = JSON.stringify(
    data?.library.sources.map((s) => [s.key, s.revision]),
  );
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setWorking(false);
  }, [query, key, match, semantic, includeReferences, sourceRevision]);
  const find = async (offset = 0) => {
    const request = ++sequence.current;
    setWorking(true);
    setError("");
    try {
      const next = await api.research<Results>(projectId, "/library/search", {
        query,
        match,
        semantic,
        includeReferences,
        keys: key ? [key] : undefined,
        limit: 20,
        offset,
      });
      if (alive.current && request === sequence.current)
        setResult((previous) =>
          offset && previous
            ? { ...next, results: [...previous.results, ...next.results] }
            : next,
        );
    } catch (err) {
      if (request === sequence.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === sequence.current) setWorking(false);
    }
  };
  const index = async (keys?: string[]) => {
    setIndexing(true);
    setError("");
    try {
      await api.research(projectId, "/jobs", { kind: "library-index", keys });
      await load();
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setIndexing(false);
    }
  };
  const groups = useMemo(() => {
    const groups = new Map<string, Hit[]>();
    for (const hit of result?.results ?? [])
      groups.set(hit.key, [...(groups.get(hit.key) ?? []), hit]);
    return [...groups];
  }, [result]);
  const status = data?.library;
  return (
    <section className="paper-library" aria-label="Source library">
      <div className="library-heading">
        <div>
          <span className="cg-eyebrow">YOUR SOURCE LIBRARY</span>
          <h3>Find the passage you need</h3>
        </div>
        {status && (
          <span className="library-coverage">
            {status.indexed} full texts ·{" "}
            {status.abstractOnly + (status.summaryOnly ?? 0)} partial
          </span>
        )}
      </div>
      <form
        className="library-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label htmlFor="library-query">Search inside your sources</label>
        <div className="library-search-row">
          <input
            id="library-query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A method, result, dataset or phrase…"
            maxLength={1000}
          />
          <button
            className="research-primary"
            disabled={working || !query.trim()}
          >
            {working ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="library-search-scope">
          <label>
            Source
            <select
              aria-label="Search within source"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            >
              <option value="">All sources</option>
              {status?.sources.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key} · {s.title}
                </option>
              ))}
            </select>
          </label>
          <span className="research-meta">
            {includeReferences
              ? "Bibliographies included"
              : "Paper content · bibliographies excluded"}
          </span>
        </div>
        <details className="library-options">
          <summary>Search options</summary>
          <div>
            <label>
              Match
              <select value={match} onChange={(e) => setMatch(e.target.value)}>
                <option value="all">All meaningful words</option>
                <option value="phrase">Exact phrase</option>
                <option value="any">Any word · broader results</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeReferences}
                onChange={(e) => setIncludeReferences(e.target.checked)}
              />
              Include bibliography sections
            </label>
            <label>
              <input
                type="checkbox"
                checked={semantic}
                onChange={(e) => setSemantic(e.target.checked)}
              />
              Expand with synonyms using the agent
            </label>
          </div>
        </details>
      </form>
      {error && (
        <p role="alert" className="research-alert">
          {error}
        </p>
      )}
      {!status && !error && <p role="status">Loading your library…</p>}
      {result && (
        <div aria-live="polite" className="library-results">
          <div className="library-results-heading">
            <strong>
              {result.total} {result.total === 1 ? "passage" : "passages"} in{" "}
              {result.sourceCount} {result.sourceCount === 1 ? "source" : "sources"}
            </strong>
            <span>
              {result.excludedReferences > 0
                ? `${result.excludedReferences} bibliography matches hidden`
                : "Ranked by relevance"}
            </span>
          </div>
          {!!result.expanded.length && (
            <p className="research-meta">
              Also searched: {result.expanded.join(", ")}
            </p>
          )}
          {!result.total && (
            <div className="library-empty">
              <h4>No matching content passages</h4>
              <p>
                Try fewer words, use “Any word”, or include bibliographies in
                search options. Sources without readable text cannot appear in
                these results.
              </p>
            </div>
          )}
          {groups.map(([key, hits]) => (
            <article key={key} className="library-result-group">
              <header>
                <div>
                  <span className="library-citekey">{key}</span>
                  <h4>{hits[0].title}</h4>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onRead ? onRead(key, hits[0].page) : open(key, hits[0].page)
                  }
                >
                  Read & take notes ↗
                </button>
              </header>
              {hits.map((hit) => (
                <div
                  className="library-passage"
                  key={`${hit.page}:${hit.offset}`}
                >
                  <span className="library-page-label">
                    {hit.basis === "full_text"
                      ? `Page ${hit.page}`
                      : hit.basis === "summary"
                        ? "Publisher summary"
                        : "Abstract"}
                    {hit.section === "references"
                      ? " · Bibliography"
                      : hit.section === "appendix"
                        ? " · Appendix"
                        : ""}
                  </span>
                  <blockquote>
                    <Highlight text={hit.quote} terms={hit.matchedTerms} />
                  </blockquote>
                  <button
                    className="research-link"
                    type="button"
                    onClick={() => open(key, hit.page, hit.matchedTerms)}
                  >
                    Read in context →
                  </button>
                </div>
              ))}
            </article>
          ))}
          {result.nextOffset !== undefined && (
            <button
              disabled={working}
              onClick={() => void find(result.nextOffset)}
            >
              {working ? "Loading…" : "Load more passages"}
            </button>
          )}
        </div>
      )}
      {status && (
        <details className="library-sources" open={!result || undefined}>
          <summary>
            Your sources <span>{status.sources.length}</span>
          </summary>
          <div className="library-index-actions">
            <p className="research-meta">
              Text is indexed automatically. Add a PDF in References when full
              text is unavailable.
            </p>
            <button
              disabled={indexing || !status.pending.length}
              onClick={() => void index()}
            >
              Retry missing text
              {status.pending.length ? ` (${status.pending.length})` : ""}
            </button>
          </div>
          {!status.sources.length && (
            <div className="library-empty">
              <h4>Start with a source</h4>
              <p>
                Add a paper in References. Its available text will appear here
                automatically.
              </p>
            </div>
          )}
          {status.sources
            .filter((s) => !key || s.key === key)
            .map((s) => (
              <article className="library-source-row" key={s.key}>
                <div>
                  <span className="library-citekey">{s.key}</span>
                  <h4>{s.title}</h4>
                  <span className={`library-source-status ${s.status}`}>
                    {statusLabel[s.status]}
                    {s.pages ? ` · ${s.pages} pages` : ""}
                  </span>
                </div>
                <div className="library-source-actions">
                  <button
                    onClick={() => (onRead ? onRead(s.key) : open(s.key, 1))}
                  >
                    Read & take notes
                  </button>
                  <button onClick={() => onOpenGraph(s.key)}>Graph ↗</button>
                  <details>
                    <summary aria-label={`Source options for ${s.key}`}>
                      •••
                    </summary>
                    <button
                      disabled={indexing}
                      onClick={() => void index([s.key])}
                    >
                      Refresh text
                    </button>
                    {s.limitations.map((l, i) => (
                      <p className="research-meta" key={i}>
                        {l}
                      </p>
                    ))}
                    {!!s.emptyPages.length && (
                      <p className="research-meta">
                        No extractable text on pages {s.emptyPages.join(", ")}
                      </p>
                    )}
                  </details>
                </div>
              </article>
            ))}
          <ResearchTasks
            projectId={projectId}
            jobs={data.jobs}
            onChanged={load}
          />
        </details>
      )}
    </section>
  );
}
