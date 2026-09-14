import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { CitationGraph as Graph, GraphNode } from "../research";
import CitationGraphCanvas, { type GraphCamera } from "./CitationGraphCanvas";
import { graphNeighborhood, searchGraph } from "./graph-model";
import "./citation-graph.css";
import PaperSignals from "./PaperSignals";
interface Props {
  projectId: string;
  busy: boolean;
  stamp: number;
}
interface QueryResult {
  results?: (GraphNode | { node: GraphNode; citedBy?: GraphNode[] })[];
  path?: GraphNode[];
  found?: boolean;
  total?: number;
  nextOffset?: number;
  note: string;
  ranking?: string;
}
export default function CitationGraph({ projectId, busy, stamp }: Props) {
  const [graph, setGraph] = useState<Graph>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const generation = useRef(0);
  const [working, setWorking] = useState("");
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [answer, setAnswer] = useState<QueryResult>();
  const [lastQuery, setLastQuery] = useState<Record<string, unknown>>();
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const seq = ++generation.current;
    const result = await api.research<Graph>(projectId, "/graph");
    if (alive.current && seq === generation.current)
      setGraph((prev) =>
        prev
          ? {
              ...result,
              nodes:
                JSON.stringify(prev.nodes) === JSON.stringify(result.nodes)
                  ? prev.nodes
                  : result.nodes,
              edges:
                JSON.stringify(prev.edges) === JSON.stringify(result.edges)
                  ? prev.edges
                  : result.edges,
            }
          : result,
      );
    return result;
  }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 15_000;
      try {
        const result = await load();
        if (!cancelled) setLoadError("");
        if (["queued", "building"].includes(result.indexing?.state ?? ""))
          delay = 1200;
        else if (result.pendingKeys.length) delay = 5000;
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load, stamp]);
  const act = async (label: string, fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setWorking(label);
    setError("");
    try {
      await fn();
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      lock.current = false;
      if (alive.current) setWorking("");
    }
  };
  const expand = () =>
    void act("Loading references…", async () => {
      await api.research<Graph>(projectId, "/graph/expand", { node: selected });
      await load();
      if (alive.current) setAnswer(undefined);
    });
  const retry = () =>
    void act("Scheduling another attempt…", async () => {
      const result = await api.research<Graph>(projectId, "/graph/retry", {});
      if (alive.current) setGraph(result);
    });
  const query = (body: Record<string, unknown>) =>
    void act("Finding connections…", async () => {
      const result = await api.research<QueryResult>(
        projectId,
        "/graph/query",
        body,
      );
      if (alive.current) {
        setAnswer(result);
        setLastQuery(body);
      }
    });
  const [fullscreen, setFullscreen] = useState(false);
  const [mode, setMode] = useState<"network" | "timeline">("network");
  const [scope, setScope] = useState("all");
  const [sort, setSort] = useState("project");
  const [depth, setDepth] = useState(0);
  const [direction, setDirection] = useState<"both" | "outgoing" | "incoming">(
    "both",
  );
  const [labels, setLabels] = useState(true);
  const [since, setSince] = useState("");
  const [page, setPage] = useState(0);
  const [compare, setCompare] = useState(false);
  const [detail, setDetail] = useState<GraphNode>();
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const mount = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "research-panel cg-portal-root";
    return element;
  });
  useLayoutEffect(() => {
    (fullscreen ? document.body : mount.current)?.appendChild(host);
    return () => host.remove();
  }, [host, fullscreen]);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const camera = useRef<GraphCamera>(null);
  const wasFullscreen = useRef(false);
  useEffect(() => {
    const element = dialog.current!;
    element.close();
    if (fullscreen) element.showModal();
    else element.show();
    if (fullscreen) search.current?.focus();
    else if (wasFullscreen.current) fullscreenButton.current?.focus();
    wasFullscreen.current = fullscreen;
    return () => element.close();
  }, [fullscreen]);
  useEffect(() => {
    if (!fullscreen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [fullscreen]);
  useEffect(() => {
    setPage(0);
  }, [filter, scope, since, depth, direction, selected]);
  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setDetailError("");
    setDetailBusy(false);
    // Bibliography-only nodes can still have an indexed local paper.
    if (!selected) return;
    setDetailBusy(true);
    void api
      .research<GraphNode>(projectId, "/graph/details", { node: selected })
      .then((node) => {
        if (!cancelled) setDetail(node);
      })
      .catch((err) => {
        if (!cancelled)
          setDetailError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, detailRetry]);
  const node = selectedNode
    ? { ...selectedNode, ...(detail?.id === selected ? detail : {}) }
    : undefined;
  const projects = useMemo(
    () => graph?.nodes.filter((n) => n.inProject) ?? [],
    [graph?.nodes],
  );
  const incoming = useMemo(
    () =>
      new Set(graph?.edges.filter((e) => e.to === selected).map((e) => e.from)),
    [graph?.edges, selected],
  );
  const outgoing = useMemo(
    () =>
      new Set(graph?.edges.filter((e) => e.from === selected).map((e) => e.to)),
    [graph?.edges, selected],
  );
  const visible = useMemo(() => {
    const neighborhood =
      selected && depth
        ? graphNeighborhood(graph?.edges ?? [], selected, depth, direction)
        : undefined;
    return new Set(
      (graph?.nodes ?? [])
        .filter(
          (n) =>
            (!neighborhood || neighborhood.has(n.id)) &&
            (scope === "all" ||
              (scope === "project" ? n.inProject : !n.inProject)) &&
            (!since || (!!n.year && n.year >= Number(since))),
        )
        .map((n) => n.id),
    );
  }, [graph?.nodes, graph?.edges, selected, depth, direction, scope, since]);
  const results = useMemo(
    () =>
      searchGraph(graph?.nodes ?? [], filter)
        .filter((n) => visible.has(n.id))
        .sort(
          (a, b) =>
            (sort === "relevance"
              ? (b.relevance?.score ?? -1) - (a.relevance?.score ?? -1)
              : sort === "impact"
                ? (b.citationPercentile ?? -1) - (a.citationPercentile ?? -1)
                : sort === "citations"
                  ? (b.citationCount ?? -1) - (a.citationCount ?? -1)
                  : sort === "recent"
                    ? (b.year ?? 0) - (a.year ?? 0)
                    : Number(b.inProject) - Number(a.inProject)) ||
            a.title.localeCompare(b.title),
        ),
    [graph?.nodes, filter, visible, sort],
  );
  const matches = useMemo(
    () => (filter.trim() ? new Set(results.map((n) => n.id)) : undefined),
    [results, filter],
  );
  const path = useMemo(() => answer?.path?.map((n) => n.id) ?? [], [answer]);
  const connections = useMemo(
    () =>
      (graph?.nodes ?? []).filter(
        (n) =>
          (direction !== "incoming" && outgoing.has(n.id)) ||
          (direction !== "outgoing" && incoming.has(n.id)),
      ),
    [graph?.nodes, outgoing, incoming, direction],
  );
  const pick = (paper: GraphNode) => {
    setSelected(paper.id);
    setFilter("");
    setScope("all");
    setSince("");
    requestAnimationFrame(() => camera.current?.center(paper.id));
  };
  const a = first || projects[0]?.id || "",
    b = second || projects[1]?.id || "";
  const indexing = graph?.indexing;
  const building =
    indexing?.state === "building" || indexing?.state === "queued";
  const gaps = Object.entries(graph?.errors ?? {});
  const exportGraph = () => {
    if (!graph) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              ...graph,
              view: { visibleNodeIds: [...visible], selected, layout: mode },
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "citation-graph.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const paperButton = (paper: GraphNode) => (
    <button
      key={paper.id}
      type="button"
      className="cg-paper"
      aria-label={`${paper.inProject ? "Project" : "External"} source: ${paper.title}`}
      onClick={() => pick(paper)}
    >
      <span
        className={`cg-paper-dot ${paper.inProject ? "project" : "external"}`}
      />
      <span>
        <strong>{paper.title}</strong>
        <small>
          {paper.keys[0] || paper.id} · {paper.year ?? "Year unknown"}
          {paper.venue ? ` · ${paper.venue}` : ""}
        </small>
      </span>
    </button>
  );
  const content = (
    <dialog
      ref={dialog}
      className={`research-graph-view cg-shell ${fullscreen ? "cg-fullscreen" : ""}`}
      aria-label="Citation graph explorer"
      onCancel={(event) => {
        event.preventDefault();
        setFullscreen(false);
      }}
      onKeyDown={(event) => {
        const typing = (event.target as HTMLElement).matches(
          "input, textarea, select",
        );
        if (
          (event.key === "/" && !typing) ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")
        ) {
          event.preventDefault();
          event.stopPropagation();
          search.current?.focus();
          search.current?.select();
        }
        if (event.key === "Escape" && !fullscreen && selected) {
          event.preventDefault();
          setSelected("");
        }
      }}
    >
      <header className="cg-heading">
        <div>
          <span className="cg-eyebrow">RESEARCH EXPLORER</span>
          <h3>Citation graph</h3>
          <p>
            {projects.length} project papers <span>·</span>{" "}
            {graph ? graph.nodes.length - projects.length : 0} external{" "}
            <span>·</span> {graph?.edges.length ?? 0} citations
          </p>
        </div>
        <button
          type="button"
          ref={fullscreenButton}
          className="cg-fullscreen-button"
          aria-label={
            fullscreen ? "Exit full screen" : "Open graph full screen"
          }
          onClick={() => setFullscreen((v) => !v)}
        >
          {fullscreen ? "↙  Exit full screen" : "⛶  Full screen"}
        </button>
      </header>
      {(error || loadError) && (
        <p role="alert" className="research-alert">
          {error || loadError}
        </p>
      )}
      {working && (
        <p role="status" className="research-progress">
          {working}
        </p>
      )}
      {!graph ? (
        <p className="research-empty">Loading your sources…</p>
      ) : !graph.nodes.length ? (
        <div className="research-graph-empty">
          <h3>Your sources connect here</h3>
          <p>
            Add papers in References or Discover. The graph builds
            automatically.
          </p>
        </div>
      ) : (
        <>
          {indexing &&
            indexing.state !== "ready" &&
            indexing.state !== "empty" && (
              <div className="cg-index-status" role="status">
                <div>
                  <strong>
                    {building
                      ? "Building automatically"
                      : indexing.reason === "network"
                        ? "Connection interrupted"
                        : indexing.reason === "rate_limit"
                          ? "OpenAlex rate limit"
                          : "Some sources need attention"}
                  </strong>
                  <span>
                    {indexing.completed} / {indexing.total} sources connected
                  </span>
                  <button
                    type="button"
                    disabled={
                      !!working || building || indexing.reason === "rate_limit"
                    }
                    onClick={retry}
                  >
                    Retry now
                  </button>
                </div>
                <progress
                  aria-label="Citation graph indexing"
                  max={indexing.total || 1}
                  value={indexing.completed}
                />
                <p>
                  {building
                    ? indexing.currentKey
                      ? `Looking up ${indexing.currentKey}`
                      : "Your sources are queued for lookup"
                    : (indexing.message ??
                      "Some sources could not be resolved yet.")}
                  {!building && indexing.retryAt
                    ? ` Next attempt after ${new Date(indexing.retryAt).toLocaleTimeString()}.`
                    : ""}
                  {indexing.metadataPending
                    ? ` ${indexing.metadataPending} sources have incomplete paper metadata.`
                    : ""}
                </p>
              </div>
            )}
          <div className="cg-controls">
            <div className="cg-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={search}
                type="search"
                aria-label="Find a paper"
                placeholder="Search titles, authors, citation keys, DOI…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setSelected("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && results[0]) {
                    event.preventDefault();
                    pick(results[0]);
                  }
                }}
              />
              <kbd>/</kbd>
            </div>
            <div className="cg-filters">
              <select
                aria-label="Paper scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">All papers</option>
                <option value="project">Project only</option>
                <option value="external">External only</option>
              </select>
              <select
                aria-label="Graph layout"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="network">Network</option>
                <option value="timeline">Timeline</option>
              </select>
              <input
                type="number"
                min="1000"
                max="2100"
                aria-label="Published since year"
                placeholder="Since year"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={labels}
                  onChange={(e) => setLabels(e.target.checked)}
                />
                Labels
              </label>
              <button
                type="button"
                onClick={exportGraph}
                title="Download papers, directed citations, and provenance"
              >
                Export JSON ↓
              </button>
            </div>
          </div>
          <div className="cg-workspace">
            <div className="cg-map">
              <div className="cg-legend">
                <span>
                  <i className="project" />
                  Project
                </span>
                <span>
                  <i className="external" />
                  External
                </span>
                <span>
                  <i className="pending" />
                  Unresolved
                </span>
                <small>A → B means A cites B</small>
              </div>
              <CitationGraphCanvas
                ref={camera}
                nodes={graph.nodes}
                edges={graph.edges}
                selected={selected}
                visible={visible}
                matches={matches}
                path={path}
                mode={mode}
                labels={labels}
                onSelect={setSelected}
              />
              <div className="cg-map-footer">
                <span>
                  {visible.size.toLocaleString()} /{" "}
                  {graph.nodes.length.toLocaleString()} papers
                  {mode === "timeline"
                    ? " · Older → newer; undated at left"
                    : " · Scroll to zoom; drag to explore"}
                </span>
                <div>
                  <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => camera.current?.zoom(false)}
                  >
                    −
                  </button>
                  <button type="button" onClick={() => camera.current?.fit()}>
                    Fit graph
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => camera.current?.zoom(true)}
                  >
                    +
                  </button>
                </div>
              </div>
              {visible.size === 0 && (
                <div className="cg-no-matches">
                  No papers match these filters.
                  <button
                    type="button"
                    onClick={() => {
                      setSince("");
                      setScope("all");
                      setDepth(0);
                    }}
                  >
                    Reset filters
                  </button>
                </div>
              )}
            </div>
            <aside
              className="cg-sidebar"
              aria-label={node ? "Paper details" : "Graph papers"}
            >
              {node ? (
                <>
                  <div className="cg-detail-heading">
                    <span
                      className={`research-badge ${node.inProject ? "research-supported" : "research-abstract"}`}
                    >
                      {node.inProject
                        ? "In your project"
                        : "Outside your project"}
                    </span>
                    <button
                      type="button"
                      aria-label="Close paper details"
                      onClick={() => setSelected("")}
                    >
                      ×
                    </button>
                  </div>
                  <h3 className="cg-paper-title">{node.title}</h3>
                  <p className="cg-authors">
                    {node.authors?.length
                      ? node.authors.join(", ")
                      : "Authors not available"}
                  </p>
                  <p className="cg-publication">
                    {[node.year, node.venue, node.type?.replaceAll("-", " ")]
                      .filter(Boolean)
                      .join(" · ") || "Publication details not available"}
                  </p>
                  <p className="cg-key">{node.keys.join(", ") || node.id}</p>
                  <div className="cg-metrics">
                    <div>
                      <strong>
                        {node.referencesLoaded ? outgoing.size : "—"}
                      </strong>
                      <span>references loaded</span>
                    </div>
                    <div>
                      <strong>{incoming.size}</strong>
                      <span>citers in this graph</span>
                    </div>
                    {node.citationCount !== undefined && (
                      <div>
                        <strong>{node.citationCount.toLocaleString()}</strong>
                        <span>citations in OpenAlex</span>
                      </div>
                    )}
                  </div>

                  <div className="cg-detail-actions">
                    {node.doi && (
                      <a
                        href={`https://doi.org/${encodeURIComponent(node.doi)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Publisher record ↗
                      </a>
                    )}
                    {/^W\d+$/.test(node.id) && (
                      <a
                        href={`https://openalex.org/${node.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        OpenAlex ↗
                      </a>
                    )}
                    <button
                      type="button"
                      disabled={!!working || building}
                      onClick={expand}
                    >
                      {node.referencesLoaded
                        ? "Refresh references"
                        : "Expand references"}
                    </button>
                    {!node.inProject && node.ref && (
                      <button
                        type="button"
                        className="research-primary"
                        disabled={busy || !!working}
                        onClick={() =>
                          void act("Adding reference…", async () => {
                            const added = await api.research<{
                              key: string;
                              verification?: {
                                status: string;
                                detail?: string;
                              };
                            }>(projectId, "/add-reference", { ref: node.ref });
                            await load();
                            if (
                              alive.current &&
                              added.verification?.status !== "verified"
                            )
                              setError(
                                `${added.key} was added, but its identity check is ${added.verification?.status ?? "unavailable"}. ${added.verification?.detail ?? "Review it in References."}`,
                              );
                          })
                        }
                      >
                        Add to bibliography
                      </button>
                    )}
                  </div>
                  {detailBusy && (
                    <p role="status" className="research-meta">
                      Loading paper information…
                    </p>
                  )}
                  {detailError && (
                    <div className="research-alert" role="alert">
                      Paper information unavailable: {detailError}
                      <button
                        type="button"
                        onClick={() => setDetailRetry((v) => v + 1)}
                      >
                        Retry paper details
                      </button>
                    </div>
                  )}
                  <div className="cg-abstract">
                    <h4>Abstract</h4>
                    <p>
                      {node.abstract ||
                        (detailBusy
                          ? "Retrieving the indexed abstract…"
                          : "No abstract available in the saved OpenAlex metadata. Open the paper to read its content.")}
                    </p>
                    <small>
                      Index metadata; this does not mean BlattBot has read the
                      full paper.
                    </small>
                  </div>
                  <PaperSignals
                    node={node}
                    question={graph.researchQuestion}
                    projectCount={projects.length}
                    projectCiters={
                      projects.filter((paper) => incoming.has(paper.id)).length
                    }
                  />
                  <div className="cg-connection-heading">
                    <h4>Connections</h4>
                    <select
                      aria-label="Connection direction"
                      value={direction}
                      onChange={(e) =>
                        setDirection(e.target.value as typeof direction)
                      }
                    >
                      <option value="both">Both directions</option>
                      <option value="outgoing">References →</option>
                      <option value="incoming">← Cited by</option>
                    </select>
                  </div>
                  <div className="cg-focus">
                    <select
                      aria-label="Neighborhood depth"
                      value={depth}
                      onChange={(e) => setDepth(Number(e.target.value))}
                    >
                      <option value="0">Show entire graph</option>
                      <option value="1">Focus: 1 step</option>
                      <option value="2">Focus: 2 steps</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => camera.current?.center(node.id)}
                    >
                      Center paper
                    </button>
                  </div>
                  <p className="research-meta">
                    {connections.length} connected papers loaded.{" "}
                    {direction === "both"
                      ? "Gold arrows: references. Blue arrows: papers citing this work."
                      : ""}
                  </p>
                  <div className="cg-paper-list">
                    {connections
                      .slice(page * 50, (page + 1) * 50)
                      .map(paperButton)}
                  </div>
                  {!connections.length && (
                    <p className="research-meta">
                      {node.referencesLoaded
                        ? "No connections in the loaded graph."
                        : "Expand references to retrieve this paper’s bibliography."}
                    </p>
                  )}
                  {connections.length > 50 && (
                    <div className="cg-pagination">
                      <button
                        type="button"
                        disabled={page === 0}
                        onClick={() => setPage((v) => v - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        {page + 1} / {Math.ceil(connections.length / 50)}
                      </span>
                      <button
                        type="button"
                        disabled={(page + 1) * 50 >= connections.length}
                        onClick={() => setPage((v) => v + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                  <small className="cg-provenance">
                    Source: OpenAlex
                    {node.retrievedAt
                      ? ` · Retrieved ${new Date(node.retrievedAt).toLocaleString()}`
                      : ""}
                    . Coverage can be incomplete.
                  </small>
                </>
              ) : (
                <>
                  <div className="cg-list-heading">
                    <h4>
                      {filter ? "Search results" : "Explore your sources"}
                    </h4>
                    <span>{results.length.toLocaleString()}</span>
                  </div>
                  <p className="research-meta">
                    {filter
                      ? "Matches are highlighted on the graph. Select a paper to see its connections."
                      : "Select a node or paper to see its abstract, publication details and citation connections."}
                  </p>
                  <label className="cg-sort">
                    Sort papers
                    <select
                      aria-label="Sort graph papers"
                      value={sort}
                      onChange={(event) => {
                        setSort(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="project">Project papers first</option>
                      <option value="relevance">Topic match</option>
                      <option value="impact">
                        Field-normalized citation impact
                      </option>
                      <option value="citations">Citation count</option>
                      <option value="recent">Newest first</option>
                    </select>
                  </label>
                  {sort === "relevance" && !graph.researchQuestion && (
                    <p className="research-meta">
                      Set a research question in Memory first.
                    </p>
                  )}
                  {sort === "impact" && (
                    <p className="research-meta">
                      {
                        results.filter(
                          (paper) => paper.citationPercentile !== undefined,
                        ).length
                      }{" "}
                      / {results.length} papers have loaded impact metrics. Open
                      a paper to retrieve its metrics; unavailable values sort
                      last.
                    </p>
                  )}
                  <button
                    type="button"
                    className="research-primary cg-discover-button"
                    disabled={!!working}
                    onClick={() => query({ query: "missing" })}
                  >
                    Find missing sources
                  </button>
                  <div className="cg-paper-list">
                    {results.slice(page * 50, (page + 1) * 50).map(paperButton)}
                  </div>
                  {!results.length && (
                    <p>
                      No papers match. Try a title, author, citation key or DOI,
                      or clear the filters.
                    </p>
                  )}
                  {results.length > 50 && (
                    <div className="cg-pagination">
                      <button
                        type="button"
                        disabled={page === 0}
                        onClick={() => setPage((v) => v - 1)}
                      >
                        Previous
                      </button>
                      <span>
                        {page + 1} / {Math.ceil(results.length / 50)}
                      </span>
                      <button
                        type="button"
                        disabled={(page + 1) * 50 >= results.length}
                        onClick={() => setPage((v) => v + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}
            </aside>
          </div>
          <div className="cg-bottom">
            <details
              className="research-card research-compare"
              open={compare}
              onToggle={(event) => setCompare(event.currentTarget.open)}
            >
              <summary>Compare two papers</summary>
              {compare && (
                <>
                  <div className="research-columns">
                    <label>
                      First paper
                      <select
                        value={a}
                        onChange={(e) => setFirst(e.target.value)}
                      >
                        {graph.nodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.keys[0] || n.id} · {n.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Second paper
                      <select
                        value={b}
                        onChange={(e) => setSecond(e.target.value)}
                      >
                        {graph.nodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.keys[0] || n.id} · {n.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="research-actions">
                    <button
                      type="button"
                      disabled={!!working || !a || !b || a === b}
                      onClick={() =>
                        query({ query: "shared_references", nodes: [a, b] })
                      }
                    >
                      Find shared references
                    </button>
                    <button
                      type="button"
                      disabled={!!working || !a || !b}
                      onClick={() =>
                        query({
                          query: "path",
                          node: a,
                          target: b,
                          direction: "outgoing",
                        })
                      }
                    >
                      Find citation path
                    </button>
                  </div>
                </>
              )}
            </details>
            {answer && (
              <div className="research-card cg-query-results">
                <div className="research-section-heading">
                  <h3>
                    {lastQuery?.query === "missing"
                      ? "Sources to explore"
                      : "Connections"}
                  </h3>
                  <button
                    type="button"
                    aria-label="Close query results"
                    onClick={() => setAnswer(undefined)}
                  >
                    ×
                  </button>
                </div>
                {answer.ranking && (
                  <p className="research-meta">{answer.ranking}</p>
                )}
                {answer.found !== undefined && (
                  <p>
                    {answer.found
                      ? "Citation path (in arrow order), highlighted in the graph:"
                      : "No path found in the loaded graph."}
                  </p>
                )}
                {(answer.path ?? answer.results ?? []).map((item, i) => {
                  const paper = "node" in item ? item.node : item,
                    citedBy = "citedBy" in item ? item.citedBy : undefined;
                  return (
                    <div key={`${paper.id}:${i}`} className="research-finding">
                      <button
                        type="button"
                        className="research-link"
                        onClick={() => pick(paper)}
                      >
                        {paper.keys.join(", ") || paper.id} · {paper.title}
                      </button>
                      {citedBy && (
                        <p className="research-meta">
                          Cited by {citedBy.length} project papers:{" "}
                          {citedBy.map((n) => n.keys.join(", ")).join("; ")}
                        </p>
                      )}
                    </div>
                  );
                })}
                {answer.total === 0 && (
                  <p>No matching works in the loaded graph.</p>
                )}
                {answer.nextOffset !== undefined && (
                  <button
                    type="button"
                    disabled={!!working}
                    onClick={() =>
                      query({ ...lastQuery, offset: answer.nextOffset })
                    }
                  >
                    Next results
                  </button>
                )}
              </div>
            )}
            {!!gaps.length && (
              <details className="research-card research-graph-gaps">
                <summary>
                  {gaps.length}{" "}
                  {gaps.length === 1 ? "lookup needs" : "lookups need"}{" "}
                  attention
                </summary>
                {gaps.map(([key, message]) => (
                  <p key={key}>
                    <strong>{key}</strong> · {message}
                  </p>
                ))}
                <button
                  type="button"
                  disabled={
                    !!working || building || indexing?.reason === "rate_limit"
                  }
                  onClick={retry}
                >
                  Retry unresolved sources
                </button>
              </details>
            )}
            {graph.truncated && (
              <p className="research-alert">
                The saved graph reached its limit (5,000 papers / 20,000
                citations); some relationships were omitted.
              </p>
            )}
            <details className="research-meta research-graph-about">
              <summary>About this graph · OpenAlex</summary>
              <p>{graph.note}</p>
              <p>
                Every saved paper is available in the explorer. Search
                highlights matches without discarding the surrounding graph.
                Node size reflects incoming links in this graph. Use / to
                search; focus the map and use arrow keys to pan, +/− to zoom,
                and 0 to fit.
              </p>
              <p>
                Codex can query connections, shared references, missing sources
                and citation paths from chat. Export JSON includes the directed
                graph and retrieval dates.
              </p>
              {graph.at && (
                <p>Last update: {new Date(graph.at).toLocaleString()}</p>
              )}
            </details>
          </div>
        </>
      )}
    </dialog>
  );
  return (
    <>
      <div ref={mount} className="cg-mount" />
      {createPortal(content, host)}
    </>
  );
}
