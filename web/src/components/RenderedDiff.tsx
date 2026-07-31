import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, type CompileInfo } from "../api";
import { comparePage, type DiffBox, type PageDiff } from "../pdfdiff";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Both sides render at this fixed CSS-px scale — same space as the diff boxes. */
const DIFF_SCALE = 1.25;
/** Padding around a changed region so thin edits stay visible. */
const BOX_PAD = 3;

interface Props {
  projectId: string;
  /** Local build state, owned by App (the same objects PdfPanel gets). */
  compile: CompileInfo | null;
  compiling: boolean;
  pdfStamp: number;
  /** Ask App to recompile the working state when the preview is missing/stale. */
  onEnsureCurrent: () => void;
}

type BaseState =
  | { status: "pending" }
  | { status: "ok"; sha: string }
  | { status: "failed"; log: string }
  | { status: "error"; message: string };

type Outcome =
  | { kind: "ready"; pages: PageDiff[] }
  | { kind: "current-failed" }
  | { kind: "error"; message: string };

/**
 * Proof → "Rendered diff": what changed in the OUTPUT, not the source. The
 * approval base (HEAD, compiled server-side into a per-sha cache) and the
 * current working-state PDF are rendered page by page with pdfjs and pixel-
 * compared client-side (pdfdiff.ts); changed pages get red region overlays.
 * Recomputes only on entry or the refresh button — never continuously.
 */
export default function RenderedDiff({
  projectId,
  compile,
  compiling,
  pdfStamp,
  onEnsureCurrent,
}: Props) {
  const [base, setBase] = useState<BaseState>({ status: "pending" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [comparing, setComparing] = useState(false);
  /** Bumps on the refresh button — everything recomputes once per nonce. */
  const [nonce, setNonce] = useState(0);
  const [sel, setSel] = useState(1);
  const [sideBySide, setSideBySide] = useState(false);
  const [docs, setDocs] = useState<{ base: PDFDocumentProxy; cur: PDFDocumentProxy } | null>(null);

  const ensureRef = useRef(onEnsureCurrent);
  ensureRef.current = onEnsureCurrent;
  /** The nonce whose comparison already COMPLETED — blocks auto-recomputes. */
  const doneFor = useRef(-1);

  // Entry / refresh: kick the local compile if stale and build the base (HEAD).
  useEffect(() => {
    let stale = false;
    doneFor.current = -1;
    setBase({ status: "pending" });
    setOutcome(null);
    ensureRef.current();
    api.compileRev(projectId).then(
      (r) => {
        if (stale) return;
        setBase(r.ok ? { status: "ok", sha: r.sha } : { status: "failed", log: r.log ?? "" });
      },
      (err: any) => {
        if (!stale) setBase({ status: "error", message: err?.message ?? "base compile failed" });
      },
    );
    return () => {
      stale = true;
    };
  }, [projectId, nonce]);

  // Compare once both sides exist. Later pdfStamp bumps (mid-turn recompiles)
  // do NOT re-run a completed comparison — only entry/refresh does.
  useEffect(() => {
    if (base.status !== "ok") return;
    if (doneFor.current === nonce) return;
    if (compiling || !compile) return; // the local compile is still on its way
    if (!compile.ok || !compile.hasPdf) {
      doneFor.current = nonce;
      setOutcome({ kind: "current-failed" });
      return;
    }
    let cancelled = false;
    setComparing(true);
    let baseDoc: PDFDocumentProxy | undefined;
    let curDoc: PDFDocumentProxy | undefined;
    const discard = () => {
      void baseDoc?.loadingTask.destroy();
      void curDoc?.loadingTask.destroy();
    };
    void (async () => {
      try {
        [baseDoc, curDoc] = await Promise.all([
          getDocument({ url: `/api/projects/${projectId}/pdf?rev=${base.sha}` }).promise,
          getDocument({ url: `/api/projects/${projectId}/pdf?v=${pdfStamp}` }).promise,
        ]);
        if (cancelled) {
          discard();
          return;
        }
        const total = Math.max(baseDoc.numPages, curDoc.numPages);
        const pages: PageDiff[] = [];
        for (let p = 1; p <= total; p++) {
          const inBase = p <= baseDoc.numPages;
          const inCur = p <= curDoc.numPages;
          if (!inBase || !inCur) {
            // Page-count mismatch: the extra pages are changes too.
            const grid = await renderPageGrid(inCur ? curDoc : baseDoc, p);
            if (cancelled) {
              discard();
              return;
            }
            pages.push({
              page: p,
              status: inCur ? "added" : "removed",
              ratio: 1,
              boxes: [],
              width: grid.width,
              height: grid.height,
            });
            continue;
          }
          const [a, b] = [await renderPageGrid(baseDoc, p), await renderPageGrid(curDoc, p)];
          if (cancelled) {
            discard();
            return;
          }
          const cmp = comparePage(a, b);
          pages.push({
            page: p,
            status: cmp.changed ? "changed" : "same",
            ratio: cmp.diffRatio,
            boxes: cmp.boxes,
            width: b.width,
            height: b.height,
          });
        }
        doneFor.current = nonce;
        setDocs({ base: baseDoc, cur: curDoc }); // ownership → the destroy effect
        setSel(pages.find((pg) => pg.status !== "same")?.page ?? 1);
        setOutcome({ kind: "ready", pages });
        setComparing(false);
      } catch (err: any) {
        discard();
        if (!cancelled) {
          doneFor.current = nonce;
          setOutcome({ kind: "error", message: err?.message ?? "rendered diff failed" });
          setComparing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, compile, compiling, pdfStamp, nonce, projectId]);

  // Destroy the previous documents whenever they are replaced (or on unmount).
  useEffect(() => {
    if (!docs) return;
    return () => {
      void docs.base.loadingTask.destroy();
      void docs.cur.loadingTask.destroy();
    };
  }, [docs]);

  const pages = outcome?.kind === "ready" ? outcome.pages : [];
  const changed = pages.filter((p) => p.status !== "same");
  const selDiff = pages.find((p) => p.page === sel);
  const selPos = changed.findIndex((p) => p.page === sel);

  const step = (dir: -1 | 1) => {
    if (changed.length === 0) return;
    const next = changed[(selPos + dir + changed.length) % changed.length];
    setSel(next.page);
  };

  const working = base.status === "pending" || comparing || (base.status === "ok" && !outcome);
  const statusText =
    base.status === "pending"
      ? "Compiling the approval base…"
      : comparing
        ? "Comparing pages…"
        : "Compiling the current state…";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-4 py-1.5 text-xs">
        {outcome?.kind === "ready" && changed.length > 0 && (
          <>
            <span className="text-graphite">Changed pages:</span>
            {changed.map((p) => (
              <button
                key={p.page}
                onClick={() => setSel(p.page)}
                aria-label={`Changed page ${p.page}`}
                title={
                  p.status === "added"
                    ? "New page — not in the approval base"
                    : p.status === "removed"
                      ? "Removed page — only in the approval base"
                      : `${(p.ratio * 100).toFixed(2)}% of pixels differ`
                }
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  sel === p.page
                    ? "border-pencil bg-pencil/10 text-pencil"
                    : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
                }`}
              >
                p. {p.page}
                {p.status === "added" ? " +" : p.status === "removed" ? " −" : ""}
              </button>
            ))}
            <button
              onClick={() => step(-1)}
              aria-label="Previous changed page"
              className="ml-1 rounded px-1.5 py-0.5 text-paper-dim transition-colors hover:bg-ink-3 hover:text-paper"
            >
              ‹
            </button>
            <button
              onClick={() => step(1)}
              aria-label="Next changed page"
              className="rounded px-1.5 py-0.5 text-paper-dim transition-colors hover:bg-ink-3 hover:text-paper"
            >
              ›
            </button>
            <button
              onClick={() => setSideBySide((s) => !s)}
              title="Show the approval base and the current state next to each other"
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                sideBySide
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-rule text-paper-dim hover:border-graphite hover:text-paper"
              }`}
            >
              Side by side
            </button>
          </>
        )}
        <button
          onClick={() => setNonce((n) => n + 1)}
          aria-label="Refresh rendered diff"
          title="Recompile both sides and compare again"
          className="ml-auto rounded border border-rule px-2 py-0.5 text-[11px] text-paper-dim transition-colors hover:border-leaf hover:text-leaf"
        >
          ↻ refresh
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {working && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
            <div className="compile-bar h-0.5 w-full" />
            <div className="mt-3 flex justify-center">
              <span
                role="status"
                className="rounded-full border border-rule bg-ink-2/95 px-3 py-1 font-mono text-[11px] text-gold shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
              >
                {statusText}
              </span>
            </div>
          </div>
        )}

        {base.status === "failed" ? (
          <FailureNote
            title="Base failed to compile"
            body="The approval base (the last approved state, HEAD) does not build — there is nothing sound to compare against."
            log={base.log}
          />
        ) : base.status === "error" ? (
          <FailureNote title="Rendered diff unavailable" body={base.message} />
        ) : outcome?.kind === "current-failed" ? (
          <FailureNote
            title="Current failed to compile"
            body="The working state does not build — fix the errors (see the PDF tab) and refresh."
            log={compile ? [...compile.errors, "", compile.logTail].join("\n").trim() : ""}
          />
        ) : outcome?.kind === "error" ? (
          <FailureNote title="Rendered diff failed" body={outcome.message} />
        ) : outcome?.kind === "ready" && changed.length === 0 ? (
          <div className="flex h-full items-center justify-center px-8">
            <p className="max-w-xs text-center font-serif text-sm leading-relaxed text-graphite">
              No visual changes — the rendered output of the current state matches the approval
              base on every page.
            </p>
          </div>
        ) : outcome?.kind === "ready" && docs && selDiff ? (
          <div className="h-full overflow-auto bg-[#3a3f4d] p-5">
            <p className="mb-3 text-center font-mono text-[11px] text-paper-dim">
              page {selDiff.page} · {changed.length} of {pages.length} page
              {pages.length === 1 ? "" : "s"} changed
            </p>
            {sideBySide ? (
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-center font-mono text-[10.5px] uppercase tracking-wide text-graphite">
                    base
                  </p>
                  {selDiff.status === "added" ? (
                    <MissingPage label="not in the approval base" />
                  ) : (
                    <DiffPage doc={docs.base} pageNo={selDiff.page} boxes={[]} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-center font-mono text-[10.5px] uppercase tracking-wide text-graphite">
                    current
                  </p>
                  {selDiff.status === "removed" ? (
                    <MissingPage label="removed in the current state" />
                  ) : (
                    <DiffPage doc={docs.cur} pageNo={selDiff.page} boxes={selDiff.boxes} />
                  )}
                </div>
              </div>
            ) : selDiff.status === "removed" ? (
              // The page only exists in the base — show that side, clearly labeled.
              <div>
                <p className="mb-1 text-center font-mono text-[10.5px] uppercase tracking-wide text-pencil">
                  removed — showing the approval base
                </p>
                <DiffPage doc={docs.base} pageNo={selDiff.page} boxes={[]} />
              </div>
            ) : (
              <DiffPage doc={docs.cur} pageNo={selDiff.page} boxes={selDiff.boxes} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Render one page into an offscreen canvas and lift out its pixels. */
async function renderPageGrid(doc: PDFDocumentProxy, pageNo: number) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: DIFF_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/**
 * One displayed page, rendered at the SAME fixed scale the comparison used —
 * so the diff boxes translate to plain percentages of the bitmap.
 */
function DiffPage({
  doc,
  pageNo,
  boxes,
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  boxes: DiffBox[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void (async () => {
      try {
        const page = await doc.getPage(pageNo);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: DIFF_SCALE });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setDims({ w: canvas.width, h: canvas.height });
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      } catch {
        /* render cancelled (page switch) or doc destroyed */
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNo]);

  return (
    <div
      className="relative mx-auto w-full max-w-[860px] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.35)]"
      style={{ aspectRatio: dims ? `${dims.w} / ${dims.h}` : "1 / 1.4142" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {dims &&
        boxes.map((b, i) => {
          const x = Math.max(0, b.x - BOX_PAD);
          const y = Math.max(0, b.y - BOX_PAD);
          const w = Math.min(dims.w, b.x + b.w + BOX_PAD) - x;
          const h = Math.min(dims.h, b.y + b.h + BOX_PAD) - y;
          return (
            <div
              key={i}
              data-diff-box
              className="pointer-events-none absolute rounded-[2px] border-2 border-pencil bg-pencil/10"
              style={{
                left: pct(x, dims.w),
                top: pct(y, dims.h),
                width: pct(w, dims.w),
                height: pct(h, dims.h),
              }}
            />
          );
        })}
    </div>
  );
}

function MissingPage({ label }: { label: string }) {
  return (
    <div
      className="mx-auto flex w-full max-w-[860px] items-center justify-center border border-dashed border-rule"
      style={{ aspectRatio: "1 / 1.4142" }}
    >
      <p className="px-6 text-center font-serif text-sm text-graphite">{label}</p>
    </div>
  );
}

function FailureNote({ title, body, log }: { title: string; body: string; log?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto px-8 py-6">
      <p className="text-center text-sm font-medium text-pencil">{title}</p>
      <p className="max-w-md text-center font-serif text-sm leading-relaxed text-graphite">{body}</p>
      {log && log.trim() && (
        <pre className="max-h-64 w-full max-w-2xl overflow-auto whitespace-pre-wrap rounded border border-rule bg-ink-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-paper-dim">
          {log.trim()}
        </pre>
      )}
    </div>
  );
}
