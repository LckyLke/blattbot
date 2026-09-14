import { z } from "zod";
import { readAllBibEntries } from "../citations.js";
import { titlesSimilar } from "../papers.js";
import { entryDoi } from "../bib.js";
import { bibHash } from "./evidence.js";
import { fetchJson, openAlexWork } from "./discovery.js";
import { digest, now, readStore, updateStore } from "./store.js";

export interface GraphNode {
  id: string;
  keys: string[];
  title: string;
  year?: number;
  doi?: string;
  ref?: string;
  inProject: boolean;
  resolved: boolean;
  referencesLoaded: boolean;
}
export interface GraphEdge {
  from: string;
  to: string;
  source: "OpenAlex";
  at: string;
}
interface Work {
  id: string;
  title: string;
  year?: number;
  doi?: string;
  references?: string[];
  at: string;
  truncated?: boolean;
}
interface GraphStore {
  at: string;
  bindings: Record<string, { id: string; entryHash: string }>;
  works: Record<string, Work>;
  errors: Record<string, string>;
}
export interface CitationGraph {
  at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: Record<string, string>;
  pendingKeys: string[];
  truncated: boolean;
  note: string;
}
const empty = (): GraphStore => ({
  at: "",
  bindings: {},
  works: {},
  errors: {},
});
const workId = (value: unknown) => {
  const id =
    String(value ?? "")
      .split("/")
      .pop() ?? "";
  return /^W\d+$/.test(id) ? id : "";
};
const note =
  "Directed edges mean A cites B, as indexed by OpenAlex at the recorded retrieval time. Missing edges or unresolved papers are unknown, not proof of no citation. Graph connections do not establish support for a manuscript claim; read the paper before citing it.";
function workRecord(raw: any, references: boolean): Work {
  const id = workId(raw.id);
  if (!id) throw new Error("OpenAlex returned an invalid work identifier");
  if (references && !Array.isArray(raw.referenced_works))
    throw new Error(
      "The index did not return a reference list; citation coverage is unknown.",
    );
  const refs = [
    ...new Set<string>(
      (raw.referenced_works ?? []).map(workId).filter(Boolean),
    ),
  ].filter((ref) => ref !== id);
  return {
    id,
    title: raw.display_name || `OpenAlex ${id}`,
    year: raw.publication_year,
    doi:
      typeof raw.doi === "string"
        ? raw.doi.replace(/^https?:\/\/doi.org\//, "")
        : undefined,
    at: now(),
    ...(references
      ? { references: refs.slice(0, 1000), truncated: refs.length > 1000 }
      : {}),
  };
}
export function readGraph(id: string, dir: string): CitationGraph {
  const store = readStore<GraphStore>(id, "graph", empty());
  const entries = readAllBibEntries(dir).filter(
    ({ entry }) => entry.type !== "string",
  );
  const byKey = new Map(entries.map(({ entry }) => [entry.key, entry]));
  const project = new Map<string, string[]>();
  const pendingKeys: string[] = [];
  for (const [key] of byKey) {
    const binding = store.bindings[key];
    const resolved =
      binding &&
      binding.entryHash === digest(byKey.get(key)!.fields) &&
      store.works[binding.id];
    const nodeId = resolved ? binding.id : `bib:${key}`;
    project.set(nodeId, [...(project.get(nodeId) ?? []), key]);
    if (!resolved) pendingKeys.push(key);
  }
  // Match identifiers on imported external nodes immediately, even before the
  // new bibliography entry has had its outgoing references fetched.
  for (const key of [...pendingKeys]) {
    const doi = entryDoi(byKey.get(key)!.fields)?.toLowerCase();
    const match =
      doi &&
      Object.values(store.works).find(
        (work) =>
          work.doi?.toLowerCase() === doi &&
          titlesSimilar(work.title, byKey.get(key)!.fields.title ?? ""),
      );
    if (match) {
      project.delete(`bib:${key}`);
      project.set(match.id, [...(project.get(match.id) ?? []), key]);
    }
  }
  const ids = new Set(project.keys());
  const queue = [...ids];
  const edges: GraphEdge[] = [];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    const work = store.works[from];
    truncated ||= !!work?.truncated;
    for (const to of work?.references ?? []) {
      if (edges.length >= 20000 || (ids.size >= 5000 && !ids.has(to))) {
        truncated = true;
        continue;
      }
      edges.push({ from, to, source: "OpenAlex", at: work.at });
      if (!ids.has(to)) {
        ids.add(to);
        queue.push(to);
      }
    }
  }
  const nodes = [...ids].map((nodeId): GraphNode => {
    const keys = project.get(nodeId) ?? [];
    const work = store.works[nodeId];
    const entry = byKey.get(keys[0]);
    const doi = work?.doi ?? (entry && entryDoi(entry.fields));
    return {
      id: nodeId,
      keys,
      title:
        work?.title ?? entry?.fields.title ?? `Metadata pending · ${nodeId}`,
      year: work?.year,
      doi,
      ref: doi || undefined,
      inProject: keys.length > 0,
      resolved: !!work,
      referencesLoaded: !!work?.references,
    };
  });
  const errors = Object.fromEntries(
    Object.entries(store.errors).filter(
      ([key]) => byKey.has(key) || ids.has(key),
    ),
  );
  return { at: store.at, nodes, edges, pendingKeys, errors, truncated, note };
}
function persistWork(id: string, work: Work, key?: string, entryHash?: string) {
  updateStore<GraphStore>(id, "graph", empty(), (store) => {
    store.at = now();
    store.works[work.id] = { ...store.works[work.id], ...work };
    if (key && entryHash) store.bindings[key] = { id: work.id, entryHash };
    delete store.errors[key ?? work.id];
    return store;
  });
}
async function hydrate(id: string, ids: string[], signal?: AbortSignal) {
  const store = readStore<GraphStore>(id, "graph", empty());
  const missing = [...new Set(ids)]
    .filter((work) => !store.works[work])
    .slice(0, 500);
  for (let i = 0; i < missing.length; i += 50) {
    const raw = await fetchJson(
      `https://api.openalex.org/works?filter=openalex_id:${missing.slice(i, i + 50).join("|")}&per-page=50`,
      {},
      signal,
    );
    for (const item of raw.results ?? [])
      persistWork(id, workRecord(item, false));
  }
}
const builds = new Set<string>();
export const graphBuildActive = (id: string) => builds.has(id);
export async function buildGraph(
  id: string,
  dir: string,
  keys?: string[],
  options: { signal?: AbortSignal } = {},
): Promise<CitationGraph> {
  if (builds.has(id)) throw new Error("The graph is already being updated.");
  const current = readGraph(id, dir);
  const selected = keys
    ? z.array(z.string().min(1)).min(1).max(30).parse(keys)
    : current.pendingKeys.slice(0, 20);
  builds.add(id);
  try {
    for (const key of new Set(selected)) {
      options.signal?.throwIfAborted();
      const hash = bibHash(dir, key);
      try {
        const work = workRecord(
          await openAlexWork(dir, key, options.signal),
          true,
        );
        if (hash !== bibHash(dir, key))
          throw new Error(
            "Bibliography entry changed during graph retrieval; retry.",
          );
        options.signal?.throwIfAborted();
        persistWork(id, work, key, hash);
        try {
          await hydrate(id, work.references ?? [], options.signal);
        } catch (err: any) {
          options.signal?.throwIfAborted();
          updateStore<GraphStore>(id, "graph", empty(), (s) => {
            s.errors[key] =
              `Citation edges loaded; some titles unavailable: ${err.message}`;
            return s;
          });
        }
      } catch (err: any) {
        options.signal?.throwIfAborted();
        updateStore<GraphStore>(id, "graph", empty(), (s) => {
          s.errors[key] = err.message;
          return s;
        });
      }
    }
    return readGraph(id, dir);
  } finally {
    builds.delete(id);
  }
}
export async function expandGraph(
  id: string,
  dir: string,
  node: string,
): Promise<CitationGraph> {
  const graph = readGraph(id, dir);
  const target = graph.nodes.find(
    (n) => n.id === node || n.keys.includes(node),
  );
  if (!target)
    throw new Error(
      "Node is not in the project graph. Build or query the graph first.",
    );
  if (target.keys.length) return buildGraph(id, dir, [target.keys[0]]);
  if (!workId(target.id)) throw new Error("This node cannot be resolved yet.");
  if (builds.has(id)) throw new Error("The graph is already being updated.");
  builds.add(id);
  try {
    const raw = await fetchJson(`https://api.openalex.org/works/${target.id}`);
    const work = workRecord(raw, true);
    if (work.id !== target.id)
      throw new Error("OpenAlex returned a different work");
    persistWork(id, work);
    try {
      await hydrate(id, work.references ?? []);
    } catch (err: any) {
      updateStore<GraphStore>(id, "graph", empty(), (s) => {
        s.errors[node] =
          `References loaded; some titles unavailable: ${err.message}`;
        return s;
      });
    }
    return readGraph(id, dir);
  } finally {
    builds.delete(id);
  }
}
export const graphQuerySchema = z.object({
  query: z.enum([
    "overview",
    "neighbors",
    "shared_references",
    "missing",
    "path",
  ]),
  node: z.string().optional(),
  target: z.string().optional(),
  nodes: z.array(z.string()).min(2).max(20).optional(),
  direction: z.enum(["outgoing", "incoming", "both"]).default("outgoing"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  maxDepth: z.number().int().min(1).max(12).default(6),
});
export type GraphQuery = z.input<typeof graphQuerySchema>;
export function queryGraph(id: string, dir: string, input: GraphQuery) {
  const args = graphQuerySchema.parse(input);
  const graph = readGraph(id, dir);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const resolve = (key?: string) => {
    const node = graph.nodes.find(
      (n) => n.id === key || n.keys.includes(key ?? ""),
    );
    if (!node) throw new Error(`Unknown graph node: ${key ?? "(missing)"}`);
    return node.id;
  };
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
    outgoing.get(edge.from)!.add(edge.to);
    if (!incoming.has(edge.to)) incoming.set(edge.to, new Set());
    incoming.get(edge.to)!.add(edge.from);
  }
  const meta = {
    at: graph.at,
    note: graph.note,
    errors: graph.errors,
    pendingKeys: graph.pendingKeys,
    graphTruncated: graph.truncated,
  };
  const page = <T>(items: T[]) => ({
    results: items.slice(args.offset, args.offset + args.limit),
    total: items.length,
    nextOffset:
      args.offset + args.limit < items.length
        ? args.offset + args.limit
        : undefined,
  });
  if (args.query === "overview")
    return {
      ...meta,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      projectCount: graph.nodes.filter((n) => n.inProject).length,
      ...page(graph.nodes),
    };
  if (args.query === "missing") {
    const missing = graph.nodes
      .filter((n) => !n.inProject)
      .map((node) => ({
        node,
        citedBy: [...(incoming.get(node.id) ?? [])]
          .map((id) => byId.get(id)!)
          .filter((n) => n.inProject),
      }))
      .filter((row) => row.citedBy.length)
      .sort(
        (a, b) =>
          b.citedBy.length - a.citedBy.length ||
          a.node.title.localeCompare(b.node.title),
      );
    return {
      ...meta,
      ...page(missing),
      ranking:
        "Number of distinct project works directly citing each absent work; not a quality or relevance score.",
    };
  }
  if (args.query === "shared_references") {
    if (!args.nodes)
      throw new Error("Provide at least two node IDs or citation keys.");
    const seeds = [...new Set(args.nodes.map(resolve))];
    if (seeds.length < 2)
      throw new Error("Provide at least two distinct works.");
    const shared = [...(outgoing.get(seeds[0]) ?? [])].filter((node) =>
      seeds.every((seed) => outgoing.get(seed)?.has(node)),
    );
    return { ...meta, seeds, ...page(shared.map((id) => byId.get(id)!)) };
  }
  const start = resolve(args.node);
  const connected = (node: string) =>
    args.direction === "outgoing"
      ? [...(outgoing.get(node) ?? [])]
      : args.direction === "incoming"
        ? [...(incoming.get(node) ?? [])]
        : [
            ...new Set([
              ...(outgoing.get(node) ?? []),
              ...(incoming.get(node) ?? []),
            ]),
          ];
  if (args.query === "neighbors") {
    const ids = connected(start);
    return {
      ...meta,
      node: byId.get(start),
      direction: args.direction,
      ...page(
        ids.map((id) => ({
          node: byId.get(id),
          edges: graph.edges.filter(
            (e) =>
              (e.from === start && e.to === id) ||
              (e.to === start && e.from === id),
          ),
        })),
      ),
    };
  }
  const end = resolve(args.target);
  const queue: string[][] = [[start]];
  const visited = new Set([start]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const last = path.at(-1)!;
    if (last === end)
      return {
        ...meta,
        direction: args.direction,
        path: path.map((id) => byId.get(id)),
        edges: path
          .slice(1)
          .flatMap((to, j) =>
            graph.edges.filter(
              (e) =>
                (e.from === path[j] && e.to === to) ||
                (e.to === path[j] && e.from === to),
            ),
          ),
        found: true,
      };
    if (path.length - 1 >= args.maxDepth) continue;
    for (const next of connected(last))
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
  }
  return {
    ...meta,
    found: false,
    path: [],
    note: `No path found in the loaded graph within ${args.maxDepth} steps. ${graph.note}`,
  };
}
