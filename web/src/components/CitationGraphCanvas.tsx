import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { DirectedGraph } from "graphology";
import Sigma from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
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
  mode: "network" | "timeline";
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
    const topology = useRef("");
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
          labelDensity: 0.5,
          labelGridCellSize: 100,
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
              label: muted ? null : data.label,
              size: data.size + (id === selected ? 3 : 0),
              forceLabel: active || !!matches?.has(id),
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
      sigma.on("clickNode", ({ node }) => latest.current.onSelect(node));
      sigma.on("enterNode", ({ node }) => {
        setHover(node);
        container.current!.style.cursor = "pointer";
      });
      sigma.on("leaveNode", () => {
        setHover("");
        container.current!.style.cursor = "grab";
      });
      sigma.on("clickStage", () => latest.current.onSelect(""));
      const observer = new ResizeObserver(() => {
        if (renderer.current === sigma) sigma.resize();
      });
      observer.observe(container.current!);
      return () => {
        observer.disconnect();
        sigma.kill();
        renderer.current = null;
      };
    }, []);
    useEffect(() => {
      const previous = model.current;
      const signature = JSON.stringify([
        props.mode,
        props.nodes.map((n) => n.id),
        props.edges.map((e) => [e.from, e.to]),
      ]);
      if (topology.current === signature) {
        for (const node of props.nodes)
          previous.setNodeAttribute(
            node.id,
            "label",
            `${node.keys[0] ? node.keys[0] + " · " : ""}${node.title.length > 64 ? node.title.slice(0, 61) + "…" : node.title}`,
          );
        renderer.current?.refresh();
        setSettling(false);
        return;
      }
      topology.current = signature;
      const graph = new DirectedGraph();
      const degree = new Map<string, number>();
      for (const edge of props.edges)
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
      const years = props.nodes.flatMap((n) => (n.year ? [n.year] : []));
      const density = Math.min(
        1,
        Math.sqrt(150 / Math.max(1, props.nodes.length)),
      );
      const minYear = Math.min(...years, new Date().getFullYear());
      for (let i = 0; i < props.nodes.length; i++) {
        const node = props.nodes[i];
        const old = previous.hasNode(node.id)
          ? previous.getNodeAttributes(node.id)
          : undefined;
        const radius = Math.sqrt(i + 1) * 10;
        const angle = i * 2.399963;
        graph.addNode(node.id, {
          x:
            props.mode === "timeline"
              ? ((node.year ?? minYear - 3) - minYear) * 30
              : (old?.x ?? Math.cos(angle) * radius),
          y:
            props.mode === "timeline"
              ? Math.sin(angle) * 100 + (node.inProject ? 150 : -50)
              : (old?.y ?? Math.sin(angle) * radius),
          size: node.inProject
            ? Math.min(9, 4.5 + Math.log2(1 + (degree.get(node.id) ?? 0)) / 2)
            : Math.max(
                0.7,
                Math.min(7, 2 + Math.log2(1 + (degree.get(node.id) ?? 0))) *
                  density,
              ),
          label: `${node.keys[0] ? node.keys[0] + " · " : ""}${node.title.length > 64 ? node.title.slice(0, 61) + "…" : node.title}`,
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
      sigma.setGraph(graph);
      let worker: FA2Layout | undefined;
      let stop: ReturnType<typeof setTimeout> | undefined;
      if (props.mode === "network" && graph.order > 1 && graph.size) {
        try {
          worker = new FA2Layout(graph, {
            settings: {
              barnesHutOptimize: true,
              barnesHutTheta: 0.6,
              gravity: 1,
              scalingRatio: 10,
              slowDown: 5,
            },
          });
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
      // Dragging stops the layout so the node stays where the user placed it.
      let dragged = "";
      const down: Parameters<Sigma["on"]>[1] = ({ node }: { node: string }) => {
        dragged = node;
        worker?.stop();
        setSettling(false);
        sigma.getCamera().disable();
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      };
      const captor = sigma.getMouseCaptor();
      const move = (event: {
        x: number;
        y: number;
        preventSigmaDefault(): void;
        original: MouseEvent | TouchEvent;
      }) => {
        if (!dragged) return;
        const position = sigma.viewportToGraph(event);
        graph.mergeNodeAttributes(dragged, position);
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      };
      const up = () => {
        dragged = "";
        sigma.getCamera().enable();
      };
      sigma.on("downNode", down);
      captor.on("mousemovebody", move);
      captor.on("mouseup", up);
      window.addEventListener("blur", up);
      return () => {
        clearTimeout(stop);
        worker?.kill();
        sigma.off("downNode", down);
        captor.off("mousemovebody", move);
        captor.off("mouseup", up);
        window.removeEventListener("blur", up);
        if (renderer.current === sigma) {
          sigma.getCamera().enable();
          sigma.setCustomBBox(null);
        }
      };
    }, [props.nodes, props.edges, props.mode]);
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
            <small>Click for details and connections</small>
          </div>
        )}
      </div>
    );
  },
);
