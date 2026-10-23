// Typed client for the co-author features: Overleaf review comments
// (server/src/routes/overleaf-review.ts) and the shared blattbot.md
// instructions (server/src/routes/shared-instructions.ts).
import { request } from "./api";

export interface ReviewMessage {
  id: string;
  author: string;
  userId?: string;
  time?: string;
  content: string;
}

export interface ReviewThread {
  id: string;
  docId: string;
  path: string;
  quote: string;
  offset: number;
  /** Line in the Overleaf doc. */
  line: number;
  /** Line of the quoted text in the local file; null when it is gone there. */
  localLine: number | null;
  /** The quoted text is no longer in the local file. */
  stale: boolean;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  messages: ReviewMessage[];
}

export interface ReviewChange {
  id: string;
  docId: string;
  path: string;
  kind: "insert" | "delete";
  text: string;
  offset: number;
  line: number;
  authorId?: string;
  author?: string;
  time?: string;
}

export interface OverleafReview {
  fetchedAt: string;
  threads: ReviewThread[];
  changes: ReviewChange[];
  threadsAvailable: boolean;
  warnings: string[];
}

export interface SharedInstructionsState {
  file: string;
  exists: boolean;
  content: string;
  sha256: string | null;
  truncated: boolean;
  status: "none" | "confirmed" | "unconfirmed";
  confirmedSha256: string | null;
  confirmedAt: string | null;
  active: string | null;
  needsReview: boolean;
  usingPrevious: boolean;
  error?: string;
}

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) });

export const reviewApi = {
  comments: (id: string, refresh = false) => request<OverleafReview>(`${base(id)}/overleaf/comments${refresh ? "?refresh=1" : ""}`),
  reply: (id: string, threadId: string, content: string) =>
    post<OverleafReview>(`${base(id)}/overleaf/threads/${encodeURIComponent(threadId)}/messages`, { content }),
  setResolved: (id: string, threadId: string, resolved: boolean) =>
    post<OverleafReview>(`${base(id)}/overleaf/threads/${encodeURIComponent(threadId)}/${resolved ? "resolve" : "reopen"}`),
  sharedInstructions: (id: string) => request<SharedInstructionsState>(`${base(id)}/shared-instructions`),
  confirmSharedInstructions: (id: string, sha256: string) =>
    post<SharedInstructionsState>(`${base(id)}/shared-instructions/confirm`, { sha256 }),
  createSharedInstructions: (id: string) =>
    post<{ state: SharedInstructionsState; diff: string }>(`${base(id)}/shared-instructions/create`),
};
