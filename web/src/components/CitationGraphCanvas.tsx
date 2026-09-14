import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { DirectedGraph } from "graphology";
import Sigma from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import type { MouseCoords, TouchCoords } from "sigma/types";
import { graphPositions, type GraphLayout } from "./graph-layout";
import type { CitationGraph, GraphNode } from "../research";

export interface GraphCamera {
  zoom: (inwards: boolean) => void;
  fit: () => void;
  center: (id: string) => void;
}
interface Props {
  nodes: GraphNode[];
  edges: CitationGraph["edges"];
  selected: string;
  visible: Set<string>;
  matches?: Set<string>;
  path: string[];
  mode: GraphLayout;
  revision: number;
  labels: boolean;
  onSelect: (id: string) => void;
}
const colors = {
  project: "#a6d4b0",
  external: "#bd9b67",
  pending: "#8794a4",
  dim: "#38434c",
  edge: "#536f75",
  incoming: "#95b9ee",
  outgoing: "#e2b775",
};
const duration = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;

export default forwardRef<GraphCamera, Props>(
  function CitationGraphCanvas(props, ref) {
    const container = useRef<HTMLDivElement>(null);
    const renderer = useRef<Sigma | null>(null);
    const model = useRef(new DirectedGraph());
    const layout = useRef<FA2Layout | null>(null);
    const arrangement = useRef("");
    const latest = useRef(props);
    latest.current = props;
    const [unavailable, setUnavailable] = useState(false);
    const [settling, setSettling] = useState(false);
    const [hover, setHover] = useState("");
    const center = (id: string) => {
      const sigma = renderer.current;
      const point = sigma?.getNodeDisplayData(id);
      if (point && !point.hidden)
        void sigma?.getCamera().animate(
          {
            x: point.x,
            y: point.y,
            ratio: Math.min(sigma.getCamera().ratio, 0.8),
          },
          { duration: duration() },
        );
    };
    useImperativeHandle(ref, () => ({
      center,
      zoom: (inwards) => {
        const camera = renderer.current?.getCamera();
        if (inwards) void camera?.animatedZoom({ duration: duration() });
        else void camera?.animatedUnzoom({ duration: duration() });
      },
      fit: () => {
        const sigma = renderer.current;
        if (!sigma) return;
        const points = [...latest.current.visible].flatMap((id) => {
          const point = sigma.getNodeDisplayData(id);
          return point ? [sigma.framedGraphToViewport(point)] : [];
        });
        if (!points.length) return;
        const left = Math.min(...points.map((p) => p.x)),
          right = Math.max(...points.map((p) => p.x));
        const top = Math.min(...points.map((p) => p.y)),
          bottom = Math.max(...points.map((p) => p.y));
        const center = sigma.viewportToFramedGraph({
          x: (left + right) / 2,
          y: (top + bottom) / 2,
        });
        const { width, height } = sigma.getDimensions();
        const ratio =
          sigma.getCamera().ratio *
          Math.max(
            (right - left) / Math.max(1, width - 100),
            (bottom - top) / Math.max(1, height - 100),
          );
        void sigma
          .getCamera()
          .animate(
            { ...center, ratio: Math.max(0.08, ratio) },
            { duration: duration() },
          );
      },
    }));
    useEffect(() => {
      let sigma: Sigma;
      try {
        sigma = new Sigma(model.current, container.current!, {
          allowInvalidContainer: true,
          defaultEdgeType: "arrow",
          minEdgeThickness: 0.4,
          labelColor: { color: "#dce5df" },
          labelSize: 11,
          labelFont: "Inter, system-ui, sans-serif",
          labelRenderedSizeThreshold: 4.5,
          labelDensity: 0.35,
          labelGridCellSize: 150,
          stagePadding: 40,
          minCameraRatio: 0.025,
          maxCameraRatio: 4,
          enableCameraRotation: false,
          hideLabelsOnMove: true,
          zIndex: true,
          defaultDrawNodeHover: (context, data) => {
            context.beginPath();
            context.arc(data.x, data.y, data.size + 4, 0, Math.PI * 2);
            context.strokeStyle = "#f1f5ed";
            context.lineWidth = 2;
            context.stroke();
          },
          nodeReducer: (id, data) => {
            const { selected, visible, matches, path } = latest.current;
            const active = id === selected || path.includes(id);
            const connected =
              !!selected &&
              model.current.hasNode(selected) &&
              model.current.areNeighbors(id, selected);
            const muted =
              (selected && !active && !connected) ||
              (matches && !matches.has(id) && !active && !connected);
            return {
              ...data,
              hidden: !visible.has(id),
              color: active ? "#f1f5dc" : muted ? colors.dim : data.color,
              label: muted
                ? null
                : active || (connected && visible.size < 30)
                  ? data.fullLabel
                  : data.label,
              size:
                (!data.inProject && visible.size < 250
                  ? Math.max(3, data.size)
                  : data.size) + (id === selected ? 3 : 0),
              forceLabel: active || (!!matches?.has(id) && matches.size <= 12),
              zIndex: active ? 3 : connected ? 2 : 0,
            };
          },
          edgeReducer: (edge, data) => {
            const { selected, visible, path } = latest.current;
            const [from, to] = model.current.extremities(edge);
            const onPath = path.some(
              (id, i) => id === from && path[i + 1] === to,
            );
            const active = from === selected || to === selected;
            return {
              ...data,
              hidden: !visible.has(from) || !visible.has(to),
              color: onPath
                ? "#f1f5dc"
                : from === selected
                  ? colors.outgoing
                  : to === selected
                    ? colors.incoming
                    : colors.edge,
              size: active || onPath ? 1.8 : 0.8,
              zIndex: active || onPath ? 2 : 0,
            };
          },
        });
      } catch {
        setUnavailable(true);
        container.current?.replaceChildren();
        return;
      }
      renderer.current = sigma;
      // Interaction belongs to the renderer lifetime, not metadata/layout updates.
      let dragged = "";
      let origin = { x: 0, y: 0 };
      let offset = { x: 0, y: 0 };
      let moved = false;
      let suppressClickUntil = 0;
      const release = () => {
        if (moved) suppressClickUntil = Date.now() + 250;
        dragged = "";
        moved = false;
        sigma.getCamera().enable();
        container.current!.style.cursor = "grab";
      };
      sigma.on("clickNode", ({ node }) => {
        if (Date.now() >= suppressClickUntil) latest.current.onSelect(node);
      });
      sigma.on("downNode", ({ node, event }) => {
        if ("button" in event.original && event.original.button !== 0) return;
        dragged = node;
        moved = false;
        origin = { x: event.x, y: event.y };
        layout.current?.stop();
        setSettling(false);
        // Freeze normalization so dragging an outermost node does not move others.
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
        const point = sigma.viewportToGraph(origin);
        const position = model.current.getNodeAttributes(node);
        offset = { x: position.x - point.x, y: position.y - point.y };
        sigma.getCamera().disable();
        event.preventSigmaDefault();
      });
      const move = (event: MouseCoords) => {
        if (!dragged || !model.current.hasNode(dragged)) return;
        event.preventSigmaDefault();
        event.original.preventDefault();
        if (!moved && Math.hypot(event.x - origin.x, event.y - origin.y) < 3)
          return;
        moved = true;
        container.current!.style.cursor = "grabbing";
        const point = sigma.viewportToGraph(event);
        model.current.mergeNodeAttributes(dragged, {
          x: point.x + offset.x,
          y: point.y + offset.y,
        });
      };
      const touchMove = (event: TouchCoords) => {
        if (event.touches.length !== 1) {
          release();
          return;
        }
        move({
          ...event,
          ...event.touches[0],
          preventSigmaDefault: () => event.preventSigmaDefault(),
        });
      };
      sigma.getMouseCaptor().on("mousemovebody", move);
      sigma.getMouseCaptor().on("mouseup", release);
      sigma.getTouchCaptor().on("touchmove", touchMove);
      sigma.getTouchCaptor().on("touchup", release);
      window.addEventListener("blur", release);
      sigma.on("enterNode", ({ node }) => {
        setHover(node);
        if (!dragged) container.current!.style.cursor = "grab";
      });
      sigma.on("leaveNode", () => {
        setHover("");
        container.current!.style.cursor = "grab";
      });
      sigma.on("clickStage", () => {
        if (Date.now() >= suppressClickUntil) latest.current.onSelect("");
      });
      const observer = new ResizeObserver(() => {
        if (renderer.current === sigma) sigma.resize();
      });
      observer.observe(container.current!);
      return () => {
        observer.disconnect();
        window.removeEventListener("blur", release);
        layout.current?.kill();
        layout.current = null;
        sigma.kill();
        renderer.current = null;
      };
    }, []);
    const signature = useMemo(
      () =>
        JSON.stringify([
          props.mode,
          props.revision,
          props.nodes.map((n) => [n.id, n.year]),
          props.edges.map((e) => [e.from, e.to]),
        ]),
      [props.mode, props.revision, props.nodes, props.edges],
    );
    useEffect(() => {
      const previous = model.current;
      const arrangementKey = `${props.mode}:${props.revision}`;
      const preserve = arrangement.current === arrangementKey;
      arrangement.current = arrangementKey;
      const graph = new DirectedGraph();
      const degree = new Map<string, number>();
      for (const edge of props.edges)
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
      const positions = graphPositions(props.nodes, degree, props.mode);
      const density = Math.min(
        1,
        Math.sqrt(150 / Math.max(1, props.nodes.length)),
      );
      for (let i = 0; i < props.nodes.length; i++) {
        const node = props.nodes[i];
        const old =
          preserve && previous.hasNode(node.id)
            ? previous.getNodeAttributes(node.id)
            : undefined;
        graph.addNode(node.id, {
          ...positions.get(node.id),
          ...(old ? { x: old.x, y: old.y } : {}),
          size: node.inProject
            ? Math.min(9, 4.5 + Math.log2(1 + (degree.get(node.id) ?? 0)) / 2)
            : Math.max(
                0.7,
                Math.min(7, 2 + Math.log2(1 + (degree.get(node.id) ?? 0))) *
                  density,
              ),
          inProject: node.inProject,
          label:
            node.keys[0] ||
            (node.title.length > 48
              ? node.title.slice(0, 45) + "…"
              : node.title),
          fullLabel: `${node.keys[0] ? node.keys[0] + " · " : ""}${node.title.length > 64 ? node.title.slice(0, 61) + "…" : node.title}`,
          color: !node.resolved
            ? colors.pending
            : node.inProject
              ? colors.project
              : colors.external,
        });
      }
      for (const edge of props.edges)
        if (
          graph.hasNode(edge.from) &&
          graph.hasNode(edge.to) &&
          edge.from !== edge.to &&
          !graph.hasDirectedEdge(edge.from, edge.to)
        )
          graph.addDirectedEdge(edge.from, edge.to, {
            size: 0.5,
            color: colors.edge,
          });
      model.current = graph;
      const sigma = renderer.current;
      if (!sigma) return;
      sigma.setCustomBBox(null);
      sigma.setGraph(graph);
      if (!preserve) sigma.getCamera().animatedReset({ duration: duration() });
      let worker: FA2Layout | undefined;
      let stop: ReturnType<typeof setTimeout> | undefined;
      if (
        ["network", "clusters"].includes(props.mode) &&
        graph.order > 1 &&
        graph.size
      ) {
        try {
          worker = new FA2Layout(graph, {
            settings: {
              barnesHutOptimize: true,
              barnesHutTheta: 0.6,
              gravity: 1,
              linLogMode: props.mode === "clusters",
              scalingRatio: props.mode === "clusters" ? 20 : 10,
              slowDown: 5,
            },
          });
          layout.current = worker;
          worker.start();
          setSettling(true);
          stop = setTimeout(
            () => {
              worker?.stop();
              setSettling(false);
            },
            graph.order > 500 ? 2500 : 1200,
          );
        } catch {
          setSettling(false);
        }
      } else setSettling(false);
      return () => {
        clearTimeout(stop);
        worker?.kill();
        if (layout.current === worker) layout.current = null;
      };
      // Metadata polling cannot tear down the layout or drag handlers.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
    useEffect(() => {
      for (const node of props.nodes) {
        if (model.current.hasNode(node.id))
          model.current.mergeNodeAttributes(node.id, {
            inProject: node.inProject,
            label:
              node.keys[0] ||
              (node.title.length > 48
                ? node.title.slice(0, 45) + "…"
                : node.title),
            fullLabel: `${node.keys[0] ? node.keys[0] + " · " : ""}${node.title.length > 64 ? node.title.slice(0, 61) + "…" : node.title}`,
            color: !node.resolved
              ? colors.pending
              : node.inProject
                ? colors.project
                : colors.external,
          });
      }
      renderer.current?.refresh();
    }, [props.nodes]);
    useEffect(() => {
      renderer.current?.setSetting("renderLabels", props.labels);
      renderer.current?.refresh();
    }, [
      props.selected,
      props.visible,
      props.matches,
      props.path,
      props.labels,
    ]);
    const hovered = props.nodes.find((n) => n.id === hover);
    return (
      <div
        className="cg-stage"
        role="group"
        aria-label="Interactive directed citation graph"
        tabIndex={0}
        onKeyDown={(event) => {
          const camera = renderer.current?.getCamera();
          if (!camera) return;
          const state = camera.getState();
          const shifts: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, 1],
            ArrowDown: [0, -1],
          };
          if (shifts[event.key]) {
            event.preventDefault();
            const [x, y] = shifts[event.key];
            camera.setState({
              x: state.x + x * state.ratio * 0.1,
              y: state.y + y * state.ratio * 0.1,
            });
          }
          if (["+", "="].includes(event.key)) {
            event.preventDefault();
            void camera.animatedZoom();
          }
          if (event.key === "-") {
            event.preventDefault();
            void camera.animatedUnzoom();
          }
          if (event.key === "0") {
            event.preventDefault();
            void camera.animatedReset();
          }
        }}
      >
        <div className="cg-webgl" ref={container} aria-hidden="true" />
        {unavailable && (
          <p className="cg-fallback" role="status">
            The graph renderer is unavailable in this browser. Search and browse
            every paper in the list to explore its connections.
          </p>
        )}
        {settling && (
          <span className="cg-layout-status">Arranging papers…</span>
        )}
        {hovered && (
          <div className="cg-tooltip">
            <strong>{hovered.title}</strong>
            <span>
              {hovered.year ?? "Year unknown"} ·{" "}
              {hovered.inProject ? "In your project" : "External paper"}
            </span>
            <small>Click for details · Drag to arrange</small>
          </div>
        )}
      </div>
    );
  },
);
