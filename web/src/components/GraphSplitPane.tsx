import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const saved = (key: string, fallback: number) => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

/** Pointer and keyboard resizing, with independent sizes for stacked/wide views. */
export default function GraphSplitPane({
  children,
}: {
  children: [ReactNode, ReactNode];
}) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [panelWidth, setPanelWidth] = useState(() =>
    saved("blattbot.graph.panelWidth", 380),
  );
  const [panelHeight, setPanelHeight] = useState(() =>
    saved("blattbot.graph.panelHeight", 400),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ point: number; size: number } | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("blattbot.graph.panelWidth", String(panelWidth));
      localStorage.setItem("blattbot.graph.panelHeight", String(panelHeight));
    } catch {
      /* Resizing still works when browser storage is disabled. */
    }
  }, [panelWidth, panelHeight]);
  const stacked = width < 850;
  const min = stacked ? 220 : 280;
  const max = stacked ? 700 : Math.max(min, Math.min(720, width * 0.6));
  const size = clamp(stacked ? panelHeight : panelWidth, min, max);
  const resize = (value: number) =>
    (stacked ? setPanelHeight : setPanelWidth)(clamp(value, min, max));
  return (
    <div
      ref={root}
      className={`cg-workspace ${stacked ? "cg-stacked" : ""} ${resizing ? "cg-resizing" : ""}`}
      style={{ "--cg-panel-size": `${size}px` } as CSSProperties}
    >
      {children[0]}
      <div
        role="separator"
        tabIndex={0}
        className="cg-resize"
        aria-label="Resize paper panel"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-valuemin={min}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(size)}
        title={
          stacked
            ? "Drag to resize · Use ↑ and ↓"
            : "Drag to resize · Use ← and →"
        }
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            point: stacked ? event.clientY : event.clientX,
            size,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(
              drag.current.size +
                drag.current.point -
                (stacked ? event.clientY : event.clientX),
            );
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setResizing(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setResizing(false);
        }}
        onKeyDown={(event) => {
          const increase = stacked ? "ArrowUp" : "ArrowLeft";
          const decrease = stacked ? "ArrowDown" : "ArrowRight";
          if (![increase, decrease, "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          resize(
            event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : size + (event.key === increase ? 24 : -24),
          );
        }}
      >
        <span />
      </div>
      {children[1]}
    </div>
  );
}
