import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import type { CitationGraph as Graph, GraphNode } from "../research";

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
/** Deterministic force layout, bounded to the currently visible nodes. */
function layout(nodes: GraphNode[], edges: Graph["edges"]) {
  const points = nodes.map((n, i) => ({
    ...n,
    x: 460 + Math.cos(i * 2.39996) * (n.inProject ? 120 : 290),
    y: 310 + Math.sin(i * 2.39996) * (n.inProject ? 100 : 240),
  }));
  const byId = new Map(points.map((p) => [p.id, p]));
  for (let step = 0; step < 100; step++) {
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j],
          dx = a.x - b.x,
          dy = a.y - b.y,
          d2 = Math.max(60, dx * dx + dy * dy);
        const force = Math.min(4, 240 / d2);
        a.x += dx * force;
        a.y += dy * force;
        b.x -= dx * force;
        b.y -= dy * force;
      }
    for (const edge of edges) {
      const a = byId.get(edge.from),
        b = byId.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.hypot(dx, dy) || 1,
        force = ((d - 130) / d) * 0.012;
      a.x += dx * force;
      a.y += dy * force;
      b.x -= dx * force;
      b.y -= dy * force;
    }
    for (const point of points) {
      point.x = Math.max(50, Math.min(850, point.x + (450 - point.x) * 0.002));
      point.y = Math.max(45, Math.min(565, point.y + (300 - point.y) * 0.002));
    }
  }
  return byId;
}
export default function CitationGraph({ projectId, busy, stamp }: Props) {
  const [graph, setGraph] = useState<Graph>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const generation = useRef(0);
  const [working, setWorking] = useState("");
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [onlyProject, setOnlyProject] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [answer, setAnswer] = useState<QueryResult>();
  const [lastQuery, setLastQuery] = useState<Record<string, unknown>>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<
    { x: number; y: number; panX: number; panY: number } | undefined
  >(undefined);
  const lock = useRef(false);
  const alive = useRef(true);
  const marker = useId().replaceAll(":", "");
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
        JSON.stringify(prev) === JSON.stringify(result) ? prev : result,
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
  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const neighbors = useMemo(
    () =>
      new Set(
        graph?.edges.flatMap((e) =>
          e.from === selected ? [e.to] : e.to === selected ? [e.from] : [],
        ) ?? [],
      ),
    [graph, selected],
  );
  const visible = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of graph?.edges ?? [])
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    return (graph?.nodes ?? [])
      .filter(
        (n) =>
          (!onlyProject || n.inProject) &&
          (!filter ||
            `${n.title} ${n.keys.join(" ")} ${n.id}`
              .toLowerCase()
              .includes(filter.toLowerCase())),
      )
      .sort(
        (a, b) =>
          Number(b.id === selected) - Number(a.id === selected) ||
          Number(neighbors.has(b.id)) - Number(neighbors.has(a.id)) ||
          Number(b.inProject) - Number(a.inProject) ||
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
      )
      .slice(0, 80);
  }, [graph, filter, onlyProject, selected, neighbors]);
  const points = useMemo(
    () =>
      layout(
        [...visible].sort((a, b) => a.id.localeCompare(b.id)),
        graph?.edges ?? [],
      ),
    [visible, graph],
  );
  const bounds = useMemo(() => {
    const positions = [...points.values()];
    if (!positions.length) return { x: 0, y: 0, width: 900, height: 600 };
    const left = Math.min(...positions.map((p) => p.x)) - 50;
    const top = Math.min(...positions.map((p) => p.y)) - 70;
    const width = Math.max(
      500,
      Math.max(...positions.map((p) => p.x)) + 230 - left,
    );
    const height = Math.max(
      320,
      Math.max(...positions.map((p) => p.y)) + 70 - top,
    );
    return { x: left, y: top, width, height };
  }, [points]);
  const pick = (node: GraphNode) => {
    setSelected(node.id);
    setFilter("");
    setOnlyProject(false);
  };
  const projects = graph?.nodes.filter((n) => n.inProject) ?? [];
  const a = first || projects[0]?.id || "",
    b = second || projects[1]?.id || "";
  const indexing = graph?.indexing;
  const building =
    indexing?.state === "building" || indexing?.state === "queued";
  const gaps = Object.entries(graph?.errors ?? {});
  return (
    <div className="research-graph-view">
      <div className="research-section-heading">
        <h3>Citation graph</h3>
        {graph && (
          <span>
            {projects.length} project · {graph.nodes.length - projects.length}{" "}
            external
          </span>
        )}
      </div>
      <p className="research-intro">
        Follow your sources and discover the papers they share.
      </p>
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
              <div className="research-index-status" role="status">
                <div>
                  <span
                    className={
                      building ? "research-live-dot" : "research-wait-dot"
                    }
                  />
                  <strong>
                    {building ? "Building automatically" : "Waiting to retry"}
                  </strong>
                  <span>
                    {indexing.completed} / {indexing.total} sources
                  </span>
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
                    : indexing.retryAt
                      ? `Next attempt after ${new Date(indexing.retryAt).toLocaleTimeString()}`
                      : "Some sources could not be resolved yet."}
                </p>
              </div>
            )}
          <div className="research-graph-toolbar">
            <input
              aria-label="Find a paper"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a title or citation key…"
            />
            <label className="research-inline">
              <input
                type="checkbox"
                checked={onlyProject}
                onChange={(e) => setOnlyProject(e.target.checked)}
              />
              Project only
            </label>
          </div>
          <div className="research-graph-canvas">
            <div className="research-graph-legend">
              <span>
                <i />
                Project
              </span>
              <span>
                <i />
                External
              </span>
              <span>Arrows show citations</span>
            </div>
            {!visible.length ? (
              <p className="research-empty">No papers match this filter.</p>
            ) : (
              <svg
                className="citation-graph"
                viewBox={`${bounds.x + pan.x + (bounds.width * (1 - 1 / zoom)) / 2} ${bounds.y + pan.y + (bounds.height * (1 - 1 / zoom)) / 2} ${bounds.width / zoom} ${bounds.height / zoom}`}
                role="group"
                aria-label="Interactive directed citation graph"
                onPointerDown={(e) => {
                  if ((e.target as SVGElement).closest("[data-node]")) return;
                  drag.current = {
                    x: e.clientX,
                    y: e.clientY,
                    panX: pan.x,
                    panY: pan.y,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const factor =
                    Math.max(
                      bounds.width / rect.width,
                      bounds.height / rect.height,
                    ) / zoom;
                  setPan({
                    x:
                      drag.current.panX - (e.clientX - drag.current.x) * factor,
                    y:
                      drag.current.panY - (e.clientY - drag.current.y) * factor,
                  });
                }}
                onPointerUp={() => {
                  drag.current = undefined;
                }}
                onPointerCancel={() => {
                  drag.current = undefined;
                }}
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="19"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d9275" />
                  </marker>
                </defs>
                {graph.edges.map((e) => {
                  const from = points.get(e.from),
                    to = points.get(e.to);
                  if (!from || !to) return null;
                  const active =
                    !selected || e.from === selected || e.to === selected;
                  return (
                    <line
                      key={`${e.from}:${e.to}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="#7d9275"
                      strokeWidth={active && selected ? 2 : 1.4}
                      opacity={active ? 0.7 : 0.12}
                      markerEnd={`url(#${marker})`}
                    >
                      <title>
                        {from.title} cites {to.title} · OpenAlex · {e.at}
                      </title>
                    </line>
                  );
                })}
                {[...points.values()].map((node) => (
                  <g
                    key={node.id}
                    data-node={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.inProject ? "Project source" : "External source"}: ${node.title}`}
                    onClick={() => pick(node)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(node);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <title>
                      {node.title} · {node.keys.join(", ") || node.id}
                      {!node.resolved ? " · Unresolved" : ""}
                    </title>
                    {node.id === selected && (
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={22}
                        fill="#8fb57318"
                        stroke="#8fb57355"
                      />
                    )}
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.inProject ? 11 : 8}
                      fill={node.inProject ? "#8fb573" : "#29251e"}
                      stroke={node.inProject ? "#b9d3a6" : "#cfa75b"}
                      strokeWidth={1.7}
                      strokeDasharray={node.resolved ? undefined : "3 3"}
                    />
                    {(visible.length <= 22 ||
                      node.inProject ||
                      node.id === selected ||
                      neighbors.has(node.id)) && (
                      <text
                        x={node.x + 17}
                        y={node.y + 5}
                        fontSize="14"
                        fill="#d8ddcf"
                        paintOrder="stroke"
                        stroke="#151b22"
                        strokeWidth="4"
                      >
                        {(node.keys[0] || node.title).slice(0, 28)}
                        {(node.keys[0] || node.title).length > 28 ? "…" : ""}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            )}
            <div className="research-graph-footer">
              <span>
                {graph.edges.length} links
                {visible.length < graph.nodes.length
                  ? ` · ${visible.length} of ${graph.nodes.length} papers shown`
                  : ""}
              </span>
              <div className="research-zoom">
                <button
                  type="button"
                  aria-label="Zoom out"
                  disabled={zoom <= 0.6}
                  onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                    setSelected("");
                  }}
                >
                  Reset view
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  disabled={zoom >= 3}
                  onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
                >
                  +
                </button>
              </div>
            </div>
          </div>
          {selectedNode && (
            <article className="research-card research-node-detail">
              <div className="research-section-heading">
                <span
                  className={`research-badge ${selectedNode.inProject ? "research-supported" : "research-abstract"}`}
                >
                  {selectedNode.inProject
                    ? "In your project"
                    : "Outside your project"}
                </span>
                <button
                  type="button"
                  className="research-icon-button"
                  aria-label="Close paper details"
                  onClick={() => setSelected("")}
                >
                  ×
                </button>
              </div>
              <h3>{selectedNode.title}</h3>
              <p className="research-meta">
                {selectedNode.keys.join(", ") || selectedNode.id}
                {selectedNode.year ? ` · ${selectedNode.year}` : ""}
              </p>
              <p>
                {graph.edges.filter((e) => e.from === selected).length}{" "}
                references ·{" "}
                {graph.edges.filter((e) => e.to === selected).length} incoming
                links in this graph
              </p>
              <div className="research-actions">
                <button
                  type="button"
                  disabled={!!working || building}
                  title={
                    building
                      ? "Available when the automatic lookup finishes"
                      : undefined
                  }
                  onClick={expand}
                >
                  {selectedNode.referencesLoaded
                    ? "Refresh references"
                    : "Expand references"}
                </button>
                <button
                  type="button"
                  disabled={!!working}
                  onClick={() =>
                    query({
                      query: "neighbors",
                      node: selected,
                      direction: "both",
                    })
                  }
                >
                  List connected papers
                </button>
                {selectedNode.doi && (
                  <a
                    href={`https://doi.org/${encodeURIComponent(selectedNode.doi)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Publisher record ↗
                  </a>
                )}
                {!selectedNode.inProject && selectedNode.ref && (
                  <button
                    type="button"
                    className="research-primary"
                    disabled={busy || !!working}
                    onClick={() =>
                      void act("Adding reference…", async () => {
                        const added = await api.research<{
                          key: string;
                          verification?: { status: string; detail?: string };
                        }>(projectId, "/add-reference", {
                          ref: selectedNode.ref,
                        });
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
            </article>
          )}
          <div className="research-actions research-graph-discover">
            <button
              type="button"
              className="research-primary"
              disabled={!!working}
              onClick={() => query({ query: "missing" })}
            >
              Find missing sources
            </button>
            <span>Works referenced by your papers</span>
          </div>
          <details className="research-card research-compare">
            <summary>Compare two papers</summary>
            <div className="research-columns">
              <label>
                First paper
                <select value={a} onChange={(e) => setFirst(e.target.value)}>
                  {graph.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.keys[0] || n.id} · {n.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Second paper
                <select value={b} onChange={(e) => setSecond(e.target.value)}>
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
          </details>
          {answer && (
            <div className="research-card">
              <div className="research-section-heading">
                <h3>
                  {lastQuery?.query === "missing"
                    ? "Sources to explore"
                    : "Connections"}
                </h3>
                <button
                  type="button"
                  className="research-icon-button"
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
                    ? "Citation path (in arrow order):"
                    : "No path found in the loaded graph."}
                </p>
              )}
              {(answer.path ?? answer.results ?? []).map((item, i) => {
                const node = "node" in item ? item.node : item,
                  citedBy = "citedBy" in item ? item.citedBy : undefined;
                return (
                  <div key={`${node.id}:${i}`} className="research-finding">
                    <button
                      type="button"
                      className="research-link"
                      onClick={() => pick(node)}
                    >
                      {node.keys.join(", ") || node.id} · {node.title}
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
                {gaps.length === 1 ? "lookup needs" : "lookups need"} attention
              </summary>
              {gaps.map(([key, detail]) => (
                <p key={key}>
                  <strong>{key}</strong> · {detail}
                </p>
              ))}
              <button
                type="button"
                disabled={!!working || building}
                onClick={retry}
              >
                Retry unresolved sources
              </button>
            </details>
          )}
          {graph.truncated && (
            <p className="research-alert">
              Some relationships were omitted because the graph reached its data
              limit.
            </p>
          )}
          <details className="research-meta research-graph-about">
            <summary>About this graph · OpenAlex</summary>
            <p>{graph.note}</p>
            <p>
              Drag to pan. Up to 80 papers are shown; searches and chat queries
              use the full saved graph. Dashed nodes have unresolved metadata.
            </p>
            <p>
              Codex can query connections, shared references, missing sources
              and citation paths from chat.
            </p>
            {graph.at && (
              <p>Last update: {new Date(graph.at).toLocaleString()}</p>
            )}
          </details>
        </>
      )}
    </div>
  );
}
