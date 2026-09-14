import type { GraphNode } from "../research";

export type GraphLayout = "network" | "clusters" | "radial" | "timeline";

/** Deterministic starting positions; network layouts then relax in a worker. */
export function graphPositions(
  nodes: GraphNode[],
  degree: Map<string, number>,
  mode: GraphLayout,
) {
  const positions = new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((a, b) =>
    mode === "radial"
      ? (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
        a.id.localeCompare(b.id)
      : a.id.localeCompare(b.id),
  );
  const years = nodes.flatMap((node) => (node.year ? [node.year] : []));
  const firstYear = Math.min(...years, new Date().getFullYear());
  const rows = new Map<number, number>();
  let ringStart = 0,
    ring = 0;
  ordered.forEach((node, i) => {
    let x: number, y: number;
    if (mode === "timeline") {
      const year = node.year ?? firstYear - 3;
      const row = rows.get(year) ?? 0;
      rows.set(year, row + 1);
      x = (year - firstYear) * 50;
      y = (row % 2 ? 1 : -1) * Math.ceil(row / 2) * 20;
    } else if (mode === "radial") {
      // Highest-degree papers occupy the center; rings expand to avoid crowding.
      const capacity = () => (ring === 0 ? 1 : 12 * ring);
      if (i - ringStart >= capacity()) {
        ringStart += capacity();
        ring++;
      }
      const count = Math.min(capacity(), ordered.length - ringStart);
      const angle = ((i - ringStart) * 2 * Math.PI) / count;
      x = Math.cos(angle) * ring * 45;
      y = Math.sin(angle) * ring * 45;
    } else {
      const angle = i * 2.399963;
      const radius = Math.sqrt(i + 1) * 10;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
    }
    positions.set(node.id, { x, y });
  });
  return positions;
}
