export interface Quote {
  page: number;
  quote: string;
}
export interface SourceVersion {
  key: string;
  title: string;
  basis: "full_text" | "abstract" | "none";
  source?: string;
  fileHash?: string;
  extractionHash?: string;
  textHash: string;
  entryHash: string;
  at: string;
}
export interface Evidence {
  id: string;
  file: string;
  line: number;
  claim: string;
  key: string;
  status: string;
  record?: {
    verdict: string;
    explanation: string;
    quotes: Quote[];
    source: SourceVersion;
    limited: boolean;
    checkedAt: string;
  };
}
export const matrixFields = [
  "question",
  "method",
  "data",
  "results",
  "limitations",
  "relevance",
] as const;
export interface MatrixRow {
  key: string;
  title: string;
  fields: Record<
    (typeof matrixFields)[number],
    { text: string; quotes: Quote[] }
  >;
  source: SourceVersion;
  limited: boolean;
  at: string;
  notes: string;
  reviewed: boolean;
  stale?: boolean;
}
export const memoryLabels = {
  question: "Research question",
  contribution: "Intended contribution",
  definitions: "Definitions",
  notation: "Notation",
  methods: "Methods & assumptions",
  decisions: "Decisions & reasons",
  openQuestions: "Open questions",
};
export type MemoryFields = Record<keyof typeof memoryLabels, string>;
export interface MemoryVersion {
  revision: number;
  at: string;
  fields: MemoryFields;
}
export interface Memory extends MemoryVersion {
  history: MemoryVersion[];
  proposal?: {
    fields: MemoryFields;
    reason: string;
    at: string;
    baseRevision: number;
  };
}
export interface Outline {
  text: string;
  at: string;
  approved: boolean;
  stale?: boolean;
}
export interface ReviewIssue {
  id: string;
  category: string;
  severity: string;
  explanation: string;
  suggestion: string;
  locations: { file: string; quote: string; line: number }[];
  resolved: boolean;
  note: string;
}
export interface Review {
  at: string;
  inputs: { path: string; charsRead: number; hash: string }[];
  memoryRevision: number;
  limited: boolean;
  coverage: string;
  issues: ReviewIssue[];
  stale?: boolean;
}
export interface SearchHit {
  ref: string;
  title: string;
  authors: string;
  year?: number;
  venue?: string;
  source: string;
}
export interface SearchRun {
  id: string;
  at: string;
  kind: "search" | "references" | "citing";
  query: string;
  criteria: string;
  results: SearchHit[];
  total?: number;
  cursor?: string;
  error?: string;
  decisions: Record<
    string,
    { decision: "include" | "exclude" | "pending"; reason: string }
  >;
}
export interface PublicationStatus {
  key: string;
  at: string;
  status: string;
  stale?: boolean;
  notices: { type: string; doi?: string; source?: string }[];
  note: string;
}
export interface ZoteroConfig {
  mode: "local" | "web";
  libraryType: "users" | "groups";
  libraryId: string;
  hasApiKey: boolean;
}
export interface ZoteroImport {
  itemKey: string;
  citeKey: string;
  at: string;
  version?: number;
  pdfPath?: string;
  notesPath?: string;
  warnings: string[];
}
export interface ZoteroResults {
  items: { key: string; title: string; author: string; year: string }[];
  total?: number;
  next?: number;
}
export interface ResearchData {
  jobs: ResearchJob[];
  strict: StrictReport;
  library: LibraryStatus;
  refs: { key: string; title: string }[];
  bibliography: {
    at: string;
    entries: number;
    issues: { kind: string; keys: string[]; files: string[]; detail: string }[];
    unusedKeys: string[];
    note: string;
  };
  evidence: Evidence[];
  matrix: MatrixRow[];
  outline: Outline | null;
  memory: Memory;
  review: Review | null;
  searches: SearchRun[];
  publicationStatus: Record<string, PublicationStatus>;
  zotero: ZoteroConfig;
  zoteroImports: Record<string, ZoteroImport>;
}
export interface SourcePage {
  key: string;
  page: number;
  title: string;
  basis: string;
  text: string;
  limitations: string[];
}
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
}
export interface CitationGraph {
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
  items: { key: string; state: string; error?: string }[];
  currentKey?: string;
  message?: string;
}
export interface StrictReport {
  strict: boolean;
  ready: boolean;
  open: number;
  auditCurrent: boolean;
  note: string;
  issues: {
    id: string;
    file: string;
    line: number;
    text: string;
    key?: string;
    reason: string;
    fingerprint: string;
    decision?: { reason: string; at: string };
  }[];
}
export interface LibraryStatus {
  indexed: number;
  abstractOnly: number;
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
