import type { CitationGraph, GraphNode } from "../research.js";

export const normalizePaperSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
/** Rank explicit titles and identifiers ahead of incidental metadata matches. */
export function paperSearchScore(node: GraphNode, query: string) {
  const q = normalizePaperSearch(query).trim();
  if (!q) return 0;
  const ids = [...node.keys, node.id, node.doi ?? ""].map(normalizePaperSearch);
  const title = normalizePaperSearch(node.title);
  return (ids.includes(q) ? 100 : 0) + (title === q ? 90 : title.startsWith(q) ? 60 : title.includes(q) ? 40 : 0)
    + q.split(/\s+/).filter(t => title.includes(t)).length * 5;
}
export function searchGraph(nodes: GraphNode[], query: string) {
  const terms = normalizePaperSearch(query).trim().split(/\s+/).filter(Boolean);
  return nodes.filter((node) => {
    const text = normalizePaperSearch(
      [
        node.title,
        ...node.keys,
        node.id,
        node.doi,
        ...(node.authors ?? []),
        node.year,
        node.venue,
      ].join(" "),
    );
    return terms.every((term) => text.includes(term));
  });
}
export function graphNeighborhood(
  edges: CitationGraph["edges"],
  start: string,
  depth: number,
  direction: "both" | "incoming" | "outgoing",
) {
  const adjacent = new Map<string, string[]>();
  const add = (a: string, b: string) =>
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
  for (const edge of edges) {
    if (direction !== "incoming") add(edge.from, edge.to);
    if (direction !== "outgoing") add(edge.to, edge.from);
  }
  const visited = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < depth; step++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const neighbor of adjacent.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    frontier = next;
  }
  return visited;
}
