import { z } from "zod";
import { readAllBibEntries } from "../citations.js";
import { titlesSimilar } from "../papers.js";
import { entryDoi } from "../bib.js";
import { bibHash } from "./evidence.js";
import { fetchJson, openAlexWork } from "./discovery.js";
import { digest, now, readStore, updateStore } from "./store.js";
import { sourceFailure, type SourceFailure } from "./source-failure.js";

import { readMemory } from "./memory.js";
import { topicRelevance, type TopicRelevance } from "./relevance.js";
import { collectCitationLocations, type CitationLocation } from "../usage.js";
import { libraryStatus } from "./library.js";

interface WorkDetails {
  citationPercentile?: number;
  fwci?: number;
  retracted?: boolean;
  metricsVersion?: number;
  authors?: string[];
  venue?: string;
  type?: string;
  citationCount?: number;
  abstract?: string;
  detailsLoaded?: boolean;
  retrievedAt?: string;
}

export interface GraphNode extends WorkDetails {
  relevance?: TopicRelevance;
  sourceAvailability?: string;
  manuscriptCitations?: CitationLocation[];
  metadataWarning?: string;
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
interface Work extends WorkDetails {
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
  failures?: Record<string, SourceFailure>;
}
export interface CitationGraph {
  researchQuestion?: string;
  at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: Record<string, string>;
  failures?: Record<string, SourceFailure>;
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
function workRecord(raw: any, references: boolean, details = false): Work {
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
    citationPercentile:
      typeof raw.citation_normalized_percentile?.value === "number" &&
      raw.citation_normalized_percentile.value >= 0 &&
      raw.citation_normalized_percentile.value <= 1
        ? raw.citation_normalized_percentile.value * 100
        : undefined,
    fwci:
      typeof raw.fwci === "number" && Number.isFinite(raw.fwci) && raw.fwci >= 0
        ? raw.fwci
        : undefined,
    retracted:
      typeof raw.is_retracted === "boolean" ? raw.is_retracted : undefined,
    metricsVersion: 1,
    authors: raw.authorships
      ?.slice(0, 30)
      .map((a: any) => a.author?.display_name)
      .filter((a: unknown) => typeof a === "string"),
    venue: raw.primary_location?.source?.display_name,
    type: raw.type,
    citationCount:
      typeof raw.cited_by_count === "number" ? raw.cited_by_count : undefined,
    ...(details
      ? {
          detailsLoaded: true,
          retrievedAt: now(),
          abstract: decodeAbstract(raw.abstract_inverted_index),
        }
      : {}),
    ...(references
      ? { references: refs.slice(0, 1000), truncated: refs.length > 1000 }
      : {}),
  };
}
function decodeAbstract(index: unknown): string | undefined {
  if (!index || typeof index !== "object" || Array.isArray(index))
    return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions)
      if (Number.isInteger(position) && position >= 0 && position < 2000)
        words[position] = word;
  }
  return words.join(" ").trim().slice(0, 12000) || undefined;
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
        entry?.fields.title ?? work?.title ?? `Metadata pending · ${nodeId}`,
      year:
        work?.year ??
        (entry?.fields.year && /^\d{4}$/.test(entry.fields.year)
          ? Number(entry.fields.year)
          : undefined),
      authors:
        work?.authors ??
        (entry?.fields.author
          ? entry.fields.author.split(/\s+and\s+/)
          : undefined),
      venue: work?.venue ?? entry?.fields.journal ?? entry?.fields.booktitle,
      type: work?.type,
      citationCount: work?.citationCount,
      citationPercentile: work?.citationPercentile,
      fwci: work?.fwci,
      retracted: work?.retracted,
      metricsVersion: work?.metricsVersion,
      abstract: work?.abstract,
      detailsLoaded: work?.detailsLoaded,
      retrievedAt: work?.retrievedAt,
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
  const failures = Object.fromEntries(
    Object.entries(errors).map(([key, message]) => [
      key,
      store.failures?.[key] ?? sourceFailure(message),
    ]),
  );
  const researchQuestion = readMemory(id).fields.question;
  const relevance = topicRelevance(nodes, researchQuestion);
  for (const node of nodes) node.relevance = relevance.get(node.id);
  return {
    researchQuestion,
    at: store.at,
    nodes,
    edges,
    pendingKeys,
    errors,
    failures,
    truncated,
    note,
  };
}
function persistWork(id: string, work: Work, key?: string, entryHash?: string) {
  updateStore<GraphStore>(id, "graph", empty(), (store) => {
    store.at = now();
    store.works[work.id] = { ...store.works[work.id], ...work };
    if (key && entryHash) store.bindings[key] = { id: work.id, entryHash };
    delete store.errors[key ?? work.id];
    if (store.failures) delete store.failures[key ?? work.id];
    return store;
  });
}
async function hydrate(id: string, ids: string[], signal?: AbortSignal) {
  const store = readStore<GraphStore>(id, "graph", empty());
  const missing = [...new Set(ids)]
    .filter((work) => !store.works[work])
    .slice(0, 500);
  for (let i = 0; i < missing.length; i += 100) {
    const raw = await fetchJson(
      `https://api.openalex.org/works?filter=openalex_id:${missing.slice(i, i + 100).join("|")}&per-page=100&select=id,display_name,publication_year,doi,authorships,primary_location,type,cited_by_count,citation_normalized_percentile,fwci,is_retracted`,
      {},
      signal,
    );
    const works = (raw.results ?? []).map((item: any) =>
      workRecord(item, false),
    );
    signal?.throwIfAborted();
    updateStore<GraphStore>(id, "graph", empty(), (latest) => {
      for (const work of works)
        latest.works[work.id] = { ...latest.works[work.id], ...work };
      latest.at = now();
      return latest;
    });
  }
}
const builds = new Set<string>();
export const graphBuildActive = (id: string) => builds.has(id);
export async function buildGraph(
  id: string,
  dir: string,
  keys?: string[],
  options: { signal?: AbortSignal; refresh?: boolean } = {},
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
        const saved = readStore<GraphStore>(id, "graph", empty());
        const binding = saved.bindings[key];
        const cached =
          binding?.entryHash === hash ? saved.works[binding.id] : undefined;
        const work =
          !options.refresh && cached?.references
            ? cached
            : workRecord(
                await openAlexWork(dir, key, options.signal),
                true,
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
            (s.failures ??= {})[key] = sourceFailure(err);
            return s;
          });
        }
      } catch (err: any) {
        options.signal?.throwIfAborted();
        updateStore<GraphStore>(id, "graph", empty(), (s) => {
          s.errors[key] = err.message;
          (s.failures ??= {})[key] = sourceFailure(err);
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
  if (target.keys.length)
    return buildGraph(id, dir, [target.keys[0]], { refresh: true });
  if (!workId(target.id)) throw new Error("This node cannot be resolved yet.");
  if (builds.has(id)) throw new Error("The graph is already being updated.");
  builds.add(id);
  try {
    const raw = await fetchJson(`https://api.openalex.org/works/${target.id}`);
    const work = workRecord(raw, true, true);
    if (work.id !== target.id)
      throw new Error("OpenAlex returned a different work");
    persistWork(id, work);
    try {
      await hydrate(id, work.references ?? []);
    } catch (err: any) {
      updateStore<GraphStore>(id, "graph", empty(), (s) => {
        s.errors[node] =
          `References loaded; some titles unavailable: ${err.message}`;
        (s.failures ??= {})[node] = sourceFailure(err);
        return s;
      });
    }
    return readGraph(id, dir);
  } finally {
    builds.delete(id);
  }
}
/** Fetch metadata only for an existing graph node. This does not expand edges. */
export async function graphDetails(
  id: string,
  dir: string,
  node: string,
): Promise<GraphNode> {
  const target = readGraph(id, dir).nodes.find(
    (n) => n.id === node || n.keys.includes(node),
  );
  if (!target) throw new Error("Node is not in the project graph.");
  const withAvailability = (node: GraphNode): GraphNode => ({
    ...node,
    manuscriptCitations: collectCitationLocations(dir, node.keys),
    sourceAvailability: node.keys.length
      ? libraryStatus(id, dir).sources.find((source) =>
          node.keys.includes(source.key),
        )?.status
      : undefined,
  });
  if (
    !workId(target.id) ||
    (target.detailsLoaded && target.metricsVersion === 1)
  )
    return withAvailability(target);
  let raw: any;
  try { raw = await fetchJson(`https://api.openalex.org/works/${target.id}`); }
  catch (error) {
    return { ...withAvailability(target), metadataWarning: error instanceof Error ? error.message : String(error) };
  }
  const work = workRecord(raw, false, true);
  if (work.id !== target.id)
    throw new Error("OpenAlex returned a different work");
  // A metadata lookup must not clear a failed reference-list expansion.
  updateStore<GraphStore>(id, "graph", empty(), (store) => {
    store.works[work.id] = { ...store.works[work.id], ...work };
    store.at = now();
    return store;
  });
  const updated = readGraph(id, dir).nodes.find((n) => n.id === target.id);
  if (!updated)
    throw new Error("This paper was removed from the graph during lookup.");
  return withAvailability(updated);
}
export const graphQuerySchema = z.object({
  query: z.enum([
    "overview",
    "citations",
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
    researchQuestion: graph.researchQuestion,
    relevanceMethod:
      "Topic-match score (0–100): research-question word overlap with title/abstract, weighted by inverse frequency in this graph. A screening heuristic, not a probability or quality score. Citation impact and reliability are separate signals.",
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
  if (args.query === "citations") {
    const node = byId.get(resolve(args.node))!;
    return { ...meta, node, ...page(collectCitationLocations(dir, node.keys)),
      note: "Current LaTeX citation locations. Bibliography inclusions (nocite) are labeled separately from citations. These are manuscript passages, not evidence from the cited paper." };
  }
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
