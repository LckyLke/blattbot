import { useState } from "react";
import { api } from "../api";
import type { ResearchJob } from "../research";
export function ResearchTasks({
  projectId,
  jobs,
  onChanged,
}: {
  projectId: string;
  jobs: ResearchJob[];
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  async function control(jobId: string, action: string) {
    setPending(jobId);
    setError("");
    try {
      await api.research(projectId, `/jobs/${jobId}`, { action });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(undefined);
    }
  }
  const running = jobs.filter((j) =>
    ["queued", "running"].includes(j.state),
  ).length;
  const paused = jobs.filter((j) => j.state === "paused").length;
  const failed = jobs.filter((j) => j.state === "failed").length;
  const status = [
    running && `${running} running`,
    paused && `${paused} paused`,
    failed && `${failed} need attention`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!jobs.length) return null;
  return (
    <details className="research-task-list">
      <summary>Indexing {status ? `· ${status}` : "· history"}</summary>
      {error && (
        <p role="alert" className="research-error">
          {error}
        </p>
      )}
      {[...jobs].reverse().map((job) => (
        <div key={job.id} className="research-task">
          <div className="research-section-heading">
            <strong>{job.kind.replaceAll("-", " ")}</strong>
            <span>
              {job.state} · {job.items.filter((i) => i.state === "done").length}
              /{job.items.length}
            </span>
          </div>
          <progress
            max={job.items.length || 1}
            value={job.items.filter((i) => i.state !== "pending").length}
          />
          {job.currentKey && <p className="research-meta">{job.currentKey}</p>}
          {job.message && <p className="research-meta">{job.message}</p>}
          <div className="research-actions">
            {(["queued", "running"].includes(job.state)
              ? ["pause", "cancel"]
              : ["paused", "failed", "cancelled"].includes(job.state)
                ? ["resume"]
                : []
            ).map((action) => (
              <button
                key={action}
                type="button"
                disabled={pending !== undefined}
                onClick={() => void control(job.id, action)}
              >
                {action === "resume"
                  ? "Resume / retry"
                  : action === "pause"
                    ? "Pause"
                    : "Cancel"}
              </button>
            ))}
          </div>
          {job.items.some((i) => i.error) && (
            <details>
              <summary>Failed items</summary>
              {job.items
                .filter((i) => i.error)
                .map((i) => (
                  <p key={i.key} className="research-meta">
                    {i.key}: {i.error}
                    {i.retryAt &&
                      !["paused", "cancelled"].includes(job.state) && (
                        <span>
                          {" "}
                          Automatic retry after{" "}
                          {new Date(i.retryAt).toLocaleTimeString()}.
                        </span>
                      )}
                  </p>
                ))}
            </details>
          )}
        </div>
      ))}
    </details>
  );
}
