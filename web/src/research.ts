export interface SourcePage {
  totalPages: number;
  key: string;
  page: number;
  title: string;
  basis: string;
  text: string;
  limitations: string[];
}
export interface GraphNode {
  citationPercentile?: number;
  fwci?: number;
  retracted?: boolean;
  metricsVersion?: number;
  relevance?: { score: number | null; matchedTerms: string[]; basis: "title" | "title_abstract" };
  sourceAvailability?: string;
  metadataWarning?: string;
  manuscriptCitations?: { key: string; file: string; line: number; column: number; kind: "citation" | "bibliography"; excerpt: string }[];
  id: string;
  keys: string[];
  title: string;
  year?: number;
  doi?: string;
  ref?: string;
  sourceUrl?: string;
  inProject: boolean;
  resolved: boolean;
  referencesLoaded: boolean;
  authors?: string[];
  venue?: string;
  type?: string;
  citationCount?: number;
  abstract?: string;
  detailsLoaded?: boolean;
  retrievedAt?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  source: string;
  at: string;
}
export interface GraphIndexStatus {
  state: "empty" | "queued" | "building" | "ready" | "waiting";
  total: number;
  completed: number;
  pending: number;
  currentKey?: string;
  retryAt?: string;
  reason?: "network" | "rate_limit" | "unresolved" | "service";
  message?: string;
  metadataPending?: number;
}
export interface CitationGraph {
  researchQuestion?: string;
  indexing?: GraphIndexStatus;
  at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: Record<string, string>;
  pendingKeys: string[];
  truncated: boolean;
  note: string;
}
export interface ResearchJob {
  id: string;
  kind: string;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  items: { key: string; state: string; error?: string; retryAt?: number }[];
  currentKey?: string;
  message?: string;
}
export interface LibraryStatus {
  indexed: number;
  abstractOnly: number;
  summaryOnly: number;
  pending: string[];
  sources: {
    key: string;
    revision: string | null;
    title: string;
    status: string;
    pages: number;
    emptyPages: number[];
    limitations: string[];
  }[];
}
