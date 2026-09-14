export interface SourceFailure {
  kind: "network" | "rate_limit" | "unresolved" | "service";
  message: string;
  retryAt?: string;
}

export class SourceServiceError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAt?: string,
  ) {
    super(message);
  }
}

/** Also classifies older caches, which stored only the error text. */
export function sourceFailure(error: unknown): SourceFailure {
  const message = error instanceof Error ? error.message : String(error);
  const kind = /HTTP 429|rate limit/i.test(message)
    ? "rate_limit"
    : /fetch failed|network|timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
          message,
        )
      ? "network"
      : /resolve.*reliably|cannot be resolved|HTTP 404|duplicate citation|unknown citation/i.test(
            message,
          )
        ? "unresolved"
        : "service";
  return {
    kind,
    message,
    ...(error instanceof SourceServiceError && error.retryAt
      ? { retryAt: error.retryAt }
      : {}),
  };
}
