import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { appUrl } from "../urls";
import type { LibraryStatus, SourcePage } from "../research";
export interface ReadingHandle {
  flush: () => Promise<void>;
  refresh?: () => void;
}
interface Note {
  id: string;
  key: string;
  revision: number;
  text: string;
  kind: "note" | "question" | "summary";
  page?: number;
  quote: string;
  updatedAt: string;
  assessmentStale?: boolean;
  assessment?: {
    verdict: string;
    explanation: string;
    suggestedRevision: string;
    at: string;
    pages: number[];
    limited: boolean;
    source: { basis: string };
    quotes: { page: number; quote: string }[];
  };
}
const verdicts: Record<string, string> = {
  consistent: "Consistent with excerpts",
  partial: "Needs qualification",
  conflict: "Conflicting evidence",
  unclear: "Cannot establish from excerpts",
};
export default forwardRef<
  ReadingHandle,
  {
    projectId: string;
    target?: { key: string; page: number; nonce: number };
    onLibrary: (key: string) => void;
  }
>(function ReadingPanel({ projectId, target, onLibrary }, ref) {
  const workspace = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === workspace.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const [sources, setSources] = useState<LibraryStatus["sources"]>([]);
  const positionKey = `blattbot.reading-position.${projectId}`;
  const [position] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(positionKey) ?? "null");
      return saved &&
        typeof saved.key === "string" &&
        Number.isInteger(saved.page) &&
        saved.page > 0 &&
        saved.page <= 1000
        ? saved
        : undefined;
    } catch {
      return undefined;
    }
  });
  const [key, setKey] = useState<string>(target?.key ?? position?.key ?? "");
  const activeKey = useRef(key);
  activeKey.current = key;
  const [page, setPage] = useState<number>(target?.page ?? position?.page ?? 1);
  const [source, setSource] = useState<SourcePage>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [selection, setSelection] = useState("");
  const [archived, setArchived] = useState<Note>();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [newNote, setNewNote] = useState("");
  const editors = useRef(new Map<string, ReadingHandle>());
  const text = useRef<HTMLPreElement>(null);
  const documentPanel = useRef<HTMLElement>(null);
  const showPage = (page: number) => {
    setPage(page);
    documentPanel.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };
  const alive = useRef(true);
  const flush = async () => {
    await Promise.all(
      [...editors.current.values()].map((editor) => editor.flush()),
    );
  };
  useImperativeHandle(ref, () => ({
    flush,
    refresh: () => setRefresh((n) => n + 1),
  }));
  useEffect(() => {
    if (key)
      try {
        localStorage.setItem(positionKey, JSON.stringify({ key, page }));
      } catch {}
  }, [key, page, positionKey]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api
      .research<LibraryStatus>(projectId, "/library")
      .then((data) => {
        if (!cancelled) {
          setSources(data.sources);
          setKey((previous) =>
            data.sources.some((s) => s.key === previous)
              ? previous
              : data.sources[0]?.key || "",
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh]);
  useEffect(() => {
    if (target) {
      setKey(target.key);
      setPage(target.page);
      setRefresh((n) => n + 1);
    }
  }, [target]);
  useEffect(() => {
    let cancelled = false;
    setNotes([]);
    setFilter("");
    setArchived(undefined);
    if (key)
      api
        .research<Note[]>(projectId, `/notes?key=${encodeURIComponent(key)}`)
        .then((items) => {
          if (!cancelled) setNotes(items);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [projectId, key, refresh]);
  useEffect(() => {
    let cancelled = false;
    setSelection("");
    setSource(undefined);
    setError("");
    setImageError(false);
    if (!key) return;
    setLoading(true);
    api
      .research<SourcePage>(
        projectId,
        `/source/${encodeURIComponent(key)}/${page}`,
      )
      .then((next) => {
        if (!cancelled) setSource(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, key, page, refresh]);
  const choose = async (next: string) => {
    try {
      await flush();
      setKey(next);
      setPage(1);
    } catch {
      setError(
        "A note could not be saved. Retry saving it before switching papers.",
      );
    }
  };
  const saveNote = (note: Note) => {
    if (!alive.current || note.key !== activeKey.current) return;
    setNotes((items) =>
      items.some((n) => n.id === note.id)
        ? items.map((n) => (n.id === note.id ? note : n))
        : [note, ...items],
    );
  };
  const add = async () => {
    setCreating(true);
    setError("");
    try {
      const note = await api.research<Note>(projectId, "/notes", {
        key,
        text: "",
        page,
        quote: selection,
        kind: "note",
      });
      if (alive.current && note.key === activeKey.current) {
        saveNote(note);
        setNewNote(note.id);
        setSelection("");
        setFilter("");
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setCreating(false);
    }
  };
  const exportNotes = async () => {
    try {
      await flush();
      const latest = await api.research<Note[]>(
        projectId,
        `/notes?key=${encodeURIComponent(key)}`,
      );
      const title = sources.find((s) => s.key === key)?.title ?? key;
      const body =
        `# ${title}\n\nCitation key: ${key}\n\n` +
        latest
          .map(
            (n) =>
              `## ${n.kind}${n.page ? ` · page ${n.page}` : ""}\n\n${
                n.quote
                  ? n.quote
                      .split("\n")
                      .map((l) => "> " + l)
                      .join("\n") + "\n\n"
                  : ""
              }${n.text}\n${n.assessment ? `\nAgent check${n.assessmentStale ? " (stale)" : ""}: ${verdicts[n.assessment.verdict]}\n${n.assessment.explanation}\n` + n.assessment.quotes.map((q) => `\n> ${q.quote}\n\nPage ${q.page}\n`).join("") : ""}`,
          )
          .join("\n---\n\n");
      const url = URL.createObjectURL(
        new Blob([body], { type: "text/markdown;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${key.replace(/[^a-z0-9_-]/gi, "_")}-notes.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section
      ref={workspace}
      className="reading-workspace"
      aria-label="Paper reading workspace"
    >
      <div className="reading-toolbar">
        <label>
          Paper
          <select
            aria-label="Paper to read"
            value={key}
            onChange={(e) => void choose(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.key} · {s.title}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!key}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            onLibrary(key);
          }}
        >
          Search within paper
        </button>
        <button
          aria-label={
            fullscreen ? "Exit reading full screen" : "Read in full screen"
          }
          onClick={() => {
            void (
              fullscreen
                ? document.exitFullscreen()
                : workspace.current!.requestFullscreen()
            ).catch((e) => setError(e.message));
          }}
        >
          {fullscreen ? "↙ Exit full screen" : "⛶ Reading focus"}
        </button>
      </div>
      {!key ? (
        <div className="library-empty">
          <h3>Your reading desk</h3>
          <p>
            Add a source in References, then open it here to read and take
            notes.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <p className="research-alert" role="alert">
              {error}{" "}
              <button
                onClick={async () => {
                  try {
                    await flush();
                    setRefresh((n) => n + 1);
                  } catch {}
                }}
              >
                Retry loading
              </button>
            </p>
          )}
          <div className="reading-columns">
            <section
              ref={documentPanel}
              className="reading-document"
              aria-label="Paper content"
            >
              <header>
                <h3>{sources.find((s) => s.key === key)?.title ?? key}</h3>
                <div className="reading-page-controls">
                  <button
                    aria-label="Previous page"
                    disabled={loading || page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ←
                  </button>
                  <label>
                    Page{" "}
                    <input
                      aria-label="Reading page"
                      type="number"
                      min={1}
                      max={source?.totalPages ?? 1000}
                      value={page}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (
                          Number.isInteger(n) &&
                          n >= 1 &&
                          n <= (source?.totalPages ?? 1000)
                        )
                          setPage(n);
                      }}
                    />
                  </label>
                  <span>of {source?.totalPages ?? "—"}</span>
                  <button
                    aria-label="Next page"
                    disabled={loading || !source || page >= source.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    →
                  </button>
                  <button
                    aria-pressed={image}
                    disabled={source?.basis !== "full_text"}
                    onClick={() => setImage((v) => !v)}
                  >
                    {image ? "Text view" : "Original page"}
                  </button>
                </div>
              </header>
              {loading && <p role="status">Opening page…</p>}
              {source && (
                <>
                  <p className="reading-basis">
                    {source.basis === "full_text"
                      ? "Select text to anchor a note to a passage."
                      : `${source.basis === "summary" ? "Publisher summary" : "Abstract only"} · full paper unavailable`}
                  </p>
                  <div className="reading-page">
                    {image && source.basis === "full_text" ? (
                      imageError ? (
                        <p>
                          Page rendering failed. Text view is still available.
                        </p>
                      ) : (
                        <img
                          alt={`Page ${page} of ${source.title}`}
                          src={appUrl(
                            `/api/projects/${encodeURIComponent(projectId)}/research/page-image/${encodeURIComponent(key)}/${page}`,
                          )}
                          onError={() => setImageError(true)}
                        />
                      )
                    ) : (
                      <pre
                        ref={text}
                        onMouseUp={() => {
                          const s = window.getSelection();
                          setSelection(
                            s &&
                              text.current?.contains(s.anchorNode) &&
                              text.current?.contains(s.focusNode)
                              ? s.toString().trim().slice(0, 4000)
                              : "",
                          );
                        }}
                        onKeyUp={() => {
                          const s = window.getSelection();
                          if (
                            s &&
                            text.current?.contains(s.anchorNode) &&
                            text.current?.contains(s.focusNode)
                          )
                            setSelection(s.toString().trim().slice(0, 4000));
                        }}
                        tabIndex={0}
                      >
                        {source.text}
                      </pre>
                    )}
                  </div>
                  {!!source.limitations.length && (
                    <details className="research-meta">
                      <summary>Source availability</summary>
                      {source.limitations.map((l, i) => (
                        <p key={i}>{l}</p>
                      ))}
                    </details>
                  )}
                </>
              )}
            </section>
            <aside className="reading-notebook" aria-label="Paper notes">
              <header>
                <div>
                  <span className="cg-eyebrow">YOUR NOTEBOOK</span>
                  <h3>
                    Notes <span>{notes.length}</span>
                  </h3>
                </div>
                <button
                  disabled={!notes.length}
                  onClick={() => void exportNotes()}
                >
                  Export ↓
                </button>
              </header>
              <button
                className="research-primary reading-add-note"
                disabled={creating}
                onClick={() => void add()}
              >
                {creating
                  ? "Adding…"
                  : selection
                    ? "＋ Note on selected passage"
                    : `＋ Note on page ${page}`}
              </button>
              {selection && (
                <blockquote className="reading-selection">
                  {selection}
                  <button onClick={() => setSelection("")}>
                    Clear selection
                  </button>
                </blockquote>
              )}
              {!!notes.length && (
                <input
                  type="search"
                  aria-label="Filter notes"
                  placeholder="Find in your notes…"
                  value={filter}
                  onChange={(e) => {
                    void flush().catch(() => {});
                    setFilter(e.target.value);
                  }}
                />
              )}
              {archived && (
                <p role="status">
                  Note removed.{" "}
                  <button
                    onClick={async () => {
                      try {
                        const restored = await api.research<Note>(
                          projectId,
                          "/notes/archive",
                          {
                            id: archived.id,
                            revision: archived.revision,
                            archived: false,
                          },
                        );
                        saveNote(restored);
                        setArchived(undefined);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    Undo
                  </button>
                </p>
              )}
              {!notes.length && (
                <div className="reading-note-empty">
                  <h4>Make this paper your own</h4>
                  <p>
                    Capture a finding, write a question, or select a passage to
                    keep an exact quotation. Your notes stay with this paper.
                  </p>
                  <p>
                    Use “Check against paper” when you want the agent to test
                    your interpretation.
                  </p>
                </div>
              )}
              {notes.map((note) => (
                <div
                  key={note.id}
                  hidden={
                    !!filter &&
                    !`${note.text} ${note.quote}`
                      .toLowerCase()
                      .includes(filter.toLowerCase())
                  }
                >
                  <NoteEditor
                    ref={(editor) => {
                      if (editor) editors.current.set(note.id, editor);
                      else editors.current.delete(note.id);
                    }}
                    note={note}
                    projectId={projectId}
                    autoFocus={note.id === newNote}
                    onSaved={saveNote}
                    onPage={showPage}
                    onArchived={(n) => {
                      setNotes((items) => items.filter((i) => i.id !== n.id));
                      setArchived(n);
                    }}
                  />
                </div>
              ))}
            </aside>
          </div>
        </>
      )}
    </section>
  );
});

const NoteEditor = forwardRef<
  ReadingHandle,
  {
    note: Note;
    projectId: string;
    autoFocus: boolean;
    onSaved: (n: Note) => void;
    onPage: (p: number) => void;
    onArchived: (n: Note) => void;
  }
>(function NoteEditor(
  { note, projectId, autoFocus, onSaved, onPage, onArchived },
  ref,
) {
  const draftKey = `blattbot.reading-draft.${projectId}.${note.id}`;
  const [recovery, setRecovery] = useState<
    { text: string; kind: Note["kind"]; revision: number } | undefined
  >(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      return saved &&
        typeof saved.text === "string" &&
        ["note", "question", "summary"].includes(saved.kind) &&
        Number.isInteger(saved.revision)
        ? saved
        : undefined;
    } catch {
      return undefined;
    }
  });
  const [text, setText] = useState(
    recovery?.revision === note.revision ? recovery.text : note.text,
  );
  const [kind, setKind] = useState(
    recovery?.revision === note.revision ? recovery.kind : note.kind,
  );
  const [state, setState] = useState("Saved");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const current = useRef(note);
  const draft = useRef({ text, kind });
  draft.current = { text, kind };
  const pending = useRef<Promise<Note> | undefined>(undefined);
  const mounted = useRef(true);
  const dirty = text !== current.current.text || kind !== current.current.kind;
  const save = async (): Promise<Note> => {
    if (pending.current) {
      await pending.current;
      return save();
    }
    if (
      draft.current.text === current.current.text &&
      draft.current.kind === current.current.kind
    )
      return current.current;
    if (mounted.current) {
      setState("Saving…");
      setError("");
    }
    const payload = { ...current.current, ...draft.current };
    const request = api.research<Note>(projectId, "/notes", payload);
    pending.current = request;
    try {
      const saved = await request;
      current.current = saved;
      try {
        if (
          draft.current.text === saved.text &&
          draft.current.kind === saved.kind
        )
          localStorage.removeItem(draftKey);
      } catch {}
      if (mounted.current) {
        onSaved(saved);
        setRecovery(undefined);
        setState("Saved");
      }
      return saved;
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
        setState("Not saved");
      }
      throw e;
    } finally {
      pending.current = undefined;
    }
  };
  useImperativeHandle(ref, () => ({
    flush: async () => {
      await save();
    },
  }));
  useEffect(() => {
    if (dirty)
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            ...draft.current,
            revision: current.current.revision,
          }),
        );
      } catch {}
  }, [text, kind]);
  useEffect(() => {
    const timer = setTimeout(() => void save().catch(() => {}), 750);
    return () => clearTimeout(timer);
  }, [text, kind]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      void save().catch(() => {});
      mounted.current = false;
    };
  }, []);
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const saved = await save();
      const checked = await api.research<Note>(projectId, "/notes/check", {
        id: saved.id,
        revision: saved.revision,
      });
      if (mounted.current) {
        if (checked.revision === current.current.revision) {
          current.current = checked;
          onSaved(checked);
        }
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  return (
    <article className="reading-note">
      <header>
        <select
          aria-label="Note type"
          value={kind}
          onChange={(e) => setKind(e.target.value as Note["kind"])}
        >
          <option value="note">Note</option>
          <option value="summary">Summary</option>
          <option value="question">Question</option>
        </select>
        {note.page && (
          <button className="research-link" onClick={() => onPage(note.page!)}>
            Page {note.page} ↗
          </button>
        )}
        <span role="status">
          {dirty && state === "Saved" ? "Unsaved changes" : state}
        </span>
      </header>
      {recovery &&
        recovery.revision !== note.revision &&
        recovery.text !== note.text && (
          <p className="research-notice">
            An unsaved local draft was recovered from another version.{" "}
            <button
              onClick={() => {
                setText(recovery.text);
                setKind(recovery.kind);
                setRecovery(undefined);
              }}
            >
              Restore local draft
            </button>
            <button
              onClick={() => {
                setRecovery(undefined);
                try {
                  localStorage.removeItem(draftKey);
                } catch {}
              }}
            >
              Keep saved note
            </button>
          </p>
        )}
      {note.quote && <blockquote>{note.quote}</blockquote>}
      <textarea
        aria-label="Note text"
        placeholder="What matters here? Write in your own words…"
        autoFocus={autoFocus}
        value={text}
        maxLength={12000}
        rows={5}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save().catch(() => {})}
      />
      {error && (
        <p role="alert" className="research-alert">
          {error}
        </p>
      )}
      <div className="reading-note-actions">
        <button
          disabled={checking || !text.trim()}
          onClick={() => void check()}
        >
          {checking ? "Checking source excerpts…" : "Check against paper"}
        </button>
        <button
          disabled={!dirty && state !== "Not saved"}
          onClick={() => void save().catch(() => {})}
        >
          Save
        </button>
        <button
          aria-label="Remove note"
          onClick={async () => {
            try {
              const saved = await save();
              const removed = await api.research<Note>(
                projectId,
                "/notes/archive",
                { id: saved.id, revision: saved.revision, archived: true },
              );
              onArchived(removed);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Remove
        </button>
      </div>
      {note.assessment && (
        <section
          className={`reading-assessment ${note.assessmentStale || dirty ? "stale" : note.assessment.verdict}`}
          aria-label="Agent note check"
        >
          <strong>
            {note.assessmentStale || dirty
              ? "Changed · check again"
              : verdicts[note.assessment.verdict]}
          </strong>
          <p>{note.assessment.explanation}</p>
          {note.assessment.quotes.map((q, i) => (
            <blockquote key={i}>
              {q.quote}
              <button className="research-link" onClick={() => onPage(q.page)}>
                Read page {q.page} ↗
              </button>
            </blockquote>
          ))}
          <p className="research-meta">
            Agent assessment · {new Date(note.assessment.at).toLocaleString()} ·{" "}
            {note.assessment.source.basis === "full_text"
              ? "Extracted paper text"
              : "Partial source only"}{" "}
            · checked pages {note.assessment.pages.join(", ")}. This check
            covers the supplied excerpts.
          </p>
          {note.assessment.suggestedRevision && (
            <details>
              <summary>Suggested revision</summary>
              <p>{note.assessment.suggestedRevision}</p>
              <button
                disabled={dirty || note.assessmentStale}
                onClick={() => setText(note.assessment!.suggestedRevision)}
              >
                Use this revision
              </button>
            </details>
          )}
        </section>
      )}
    </article>
  );
});
