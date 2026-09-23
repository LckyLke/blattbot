import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { appUrl } from "../urls";
import type { SourcePage } from "../research";
import ReadingPanel, { type ReadingHandle } from "./ReadingPanel";
import CitationGraph from "./CitationGraph";
import PaperLibrary, { Highlight } from "./PaperLibrary";
import "./research.css";

interface Props {
  projectId: string;
  stamp: number;
  busy: boolean;
  onJump: (file: string, line: number) => void;
}
export default function ResearchPanel({
  projectId,
  stamp,
  busy,
  onJump,
}: Props) {
  const [tab, setTab] = useState<"graph" | "library" | "reading">("graph");
  const reading = useRef<ReadingHandle>(null);
  const [readingTarget, setReadingTarget] = useState<{
    key: string;
    page: number;
    nonce: number;
  }>();
  const [readingVisited, setReadingVisited] = useState(false);
  const changeTab = async (next: "graph" | "library" | "reading") => {
    try {
      await reading.current?.flush();
      if (next === "reading") setReadingVisited(true);
      setTab(next);
    } catch {
      /* The note card displays the save error; keep it visible. */
    }
  };
  const read = async (key: string, page = 1) => {
    try {
      await reading.current?.flush();
      setReadingTarget({ key, page, nonce: Date.now() });
      setReadingVisited(true);
      setTab("reading");
    } catch {
      setTab("reading");
    }
  };
  const [libraryKey, setLibraryKey] = useState("");
  const [graphKey, setGraphKey] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState<SourcePage>();
  const [opening, setOpening] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [terms, setTerms] = useState<string[]>([]);
  const [showImage, setShowImage] = useState(false);
  const [imageError, setImageError] = useState(false);
  const sequence = useRef(0);
  const reader = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [projectId],
  );
  useEffect(() => {
    panel.current?.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => {
    if (!source && !opening && !sourceError) return;
    const dialog = reader.current!;
    if (!dialog.open) dialog.showModal();
  }, [source, opening, sourceError]);
  const close = () => {
    sequence.current++;
    reader.current?.close();
    setSource(undefined);
    setSourceError("");
    setOpening(false);
  };
  const open = async (key: string, page: number, highlight: string[] = []) => {
    const request = ++sequence.current;
    setOpening(true);
    setSourceError("");
    setTerms(highlight);
    setImageError(false);
    try {
      const next = await api.research<SourcePage>(
        projectId,
        `/source/${encodeURIComponent(key)}/${page}`,
      );
      if (request === sequence.current) setSource(next);
    } catch (error) {
      if (request === sequence.current)
        setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === sequence.current) setOpening(false);
    }
  };
  return (
    <div className="research-panel research-focused" ref={panel}>
      <header className="research-shell research-topbar">
        <div>
          <h2>Research</h2>
          <span className="research-meta">
            Explore connections. Read the sources.
          </span>
        </div>
        <nav className="research-tabs" aria-label="Research views">
          {(
            [
              ["graph", "Graph"],
              ["library", "Library"],
              ["reading", "Reading"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => void changeTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          className="research-icon-button"
          type="button"
          aria-label="Refresh research"
          title="Refresh research"
          onClick={async () => {
            try {
              await reading.current?.flush();
              reading.current?.refresh?.();
              setRefresh((n) => n + 1);
            } catch {
              setTab("reading");
            }
          }}
        >
          ↻
        </button>
      </header>
      <div className="research-body">
        {tab === "graph" && (
          <CitationGraph
            projectId={projectId}
            busy={busy}
            stamp={stamp + refresh}
            onJump={onJump}
            initialKey={graphKey}
            onOpenLibrary={(key) => {
              setLibraryKey(key);
              void changeTab("library");
            }}
            onRead={(key) => void read(key)}
          />
        )}
        {tab === "library" && (
          <PaperLibrary
            projectId={projectId}
            stamp={stamp + refresh}
            initialKey={libraryKey}
            open={(key, page, terms) => void open(key, page, terms)}
            onOpenGraph={(key) => {
              setGraphKey(key);
              void changeTab("graph");
            }}
            onRead={(key, page) => void read(key, page)}
          />
        )}
        {readingVisited && (
          <div hidden={tab !== "reading"}>
            <ReadingPanel
              ref={reading}
              projectId={projectId}
              target={readingTarget}
              onLibrary={(key) => {
                setLibraryKey(key);
                void changeTab("library");
              }}
            />
          </div>
        )}
      </div>
      <dialog
        className="research-reader"
        ref={reader}
        aria-label="Read source"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="research-reader-inner">
          <header>
            <div>
              <span className="research-meta">{source?.key ?? "Library"}</span>
              <h3>{source?.title ?? "Opening source"}</h3>
            </div>
            <button type="button" aria-label="Close source" onClick={close}>
              ×
            </button>
          </header>
          <div className="research-reader-controls">
            <button
              disabled={opening || !source || source.page <= 1}
              onClick={() =>
                source && void open(source.key, source.page - 1, terms)
              }
            >
              ← Previous
            </button>
            <span>
              {source?.basis === "full_text"
                ? `Page ${source.page} of ${source.totalPages}`
                : source?.basis === "summary"
                  ? "Publisher summary"
                  : "Abstract"}
            </span>
            <button
              disabled={opening || !source || source.page >= source.totalPages}
              onClick={() =>
                source && void open(source.key, source.page + 1, terms)
              }
            >
              Next →
            </button>
            {source && (
              <button
                onClick={() => {
                  close();
                  void read(source.key, source.page);
                }}
              >
                Read & take notes
              </button>
            )}
            {source?.basis === "full_text" && (
              <button
                aria-pressed={showImage}
                onClick={() => setShowImage((v) => !v)}
              >
                {showImage ? "Read text" : "Original page"}
              </button>
            )}
          </div>
          {opening && <p role="status">Opening page…</p>}
          {sourceError && (
            <p role="alert" className="research-alert">
              {sourceError}
            </p>
          )}
          {source && !opening && !sourceError && (
            <div className="research-reader-content">
              {showImage && source.basis === "full_text" ? (
                imageError ? (
                  <p role="alert">
                    This page could not be rendered. Switch to text to read the
                    extracted content.
                  </p>
                ) : (
                  <img
                    alt={`Page ${source.page} of ${source.title}`}
                    src={appUrl(
                      `/api/projects/${encodeURIComponent(projectId)}/research/page-image/${encodeURIComponent(source.key)}/${source.page}`,
                    )}
                    onError={() => setImageError(true)}
                  />
                )
              ) : (
                <pre>
                  <Highlight text={source.text} terms={terms} />
                </pre>
              )}
              {!!source.limitations.length && (
                <details>
                  <summary>Source availability</summary>
                  {source.limitations.map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </details>
              )}
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
