import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Breadcrumbs } from "../components/Shell";
import { PageHeader } from "../components/primitives";
import { ActionButton } from "../components/ActionButton";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { useQueue } from "../api/hooks";
import { useEventStream, type StreamEnvelope } from "../realtime/useEventStream";
import { pluralize } from "../lib/format";
import type { ReviewQueueEntry, ReviewQueueState } from "../api/types";

// ─────────────────────────────────────────────────────────────────────────────
// Queue — the live review-pipeline board: Queued → Running → Done / Failed.
//
// Hydrates from GET /api/v1/queue, then tracks state purely from the
// `queue.updated` SSE stream so cards animate the moment a review starts,
// changes phase, finishes, or is canceled. Each active card shows a ticking
// elapsed timer and a cancel button (reusing the W0.4 cancel command); the
// failed lane surfaces the error plus a one-click retry.
// ─────────────────────────────────────────────────────────────────────────────

/** A monotonic rank so out-of-order events / stale refetches never regress a
 * card: a higher attempt always wins, and within an attempt the lifecycle only
 * moves forward (queued → running → terminal). */
const STATE_RANK: Record<ReviewQueueState, number> = {
  queued: 0,
  running: 1,
  done: 2,
  failed: 2,
  canceled: 2,
};
// Monotonic rank: attempt dominates (×10 ≫ the max state rank of 2), then the
// lifecycle only moves forward. A higher attempt or a later state always wins;
// equal rank means the same attempt *and* the same state class.
function rank(e: ReviewQueueEntry): number {
  return e.attempt * 10 + STATE_RANK[e.state];
}

// Live (SSE) merge — events arrive in order on the single EventSource, so a
// same-rank update (a running phase change, or a terminal re-delivery) is by
// definition newer and takes precedence.
function mergeLive(existing: ReviewQueueEntry | undefined, incoming: ReviewQueueEntry): ReviewQueueEntry {
  if (!existing) return incoming;
  return rank(incoming) >= rank(existing) ? incoming : existing;
}

// Hydration (GET /queue) merge — a snapshot may have been captured before a
// live event that already advanced the card (e.g. a phase change has the same
// rank but is fresher), so a refetch may only move a card *forward*, never
// overwrite a same-rank entry the live stream may have updated in the meantime.
function mergeHydrate(existing: ReviewQueueEntry | undefined, incoming: ReviewQueueEntry): ReviewQueueEntry {
  if (!existing) return incoming;
  return rank(incoming) > rank(existing) ? incoming : existing;
}

function isTerminal(state: ReviewQueueState): boolean {
  return state === "done" || state === "failed" || state === "canceled";
}

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  if (min >= 60) {
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/** Elapsed wall-clock for an active card, or the run duration for a finished one. */
function durationFor(entry: ReviewQueueEntry, now: number): number {
  const startIso = entry.startedAt ?? entry.enqueuedAt;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return 0;
  const end = entry.finishedAt ? Date.parse(entry.finishedAt) : now;
  return end - start;
}

const STATE_LABEL: Record<ReviewQueueState, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

interface LaneDef {
  key: string;
  title: string;
  match: (s: ReviewQueueState) => boolean;
  tone: "neutral" | "accent" | "good" | "danger";
  /** Terminal lanes sort newest-finished first; active lanes oldest-queued
   * first (longest-waiting at top). Declared per-lane so the comparator never
   * has to infer it from an individual card's state. */
  terminal: boolean;
}

const LANES: LaneDef[] = [
  { key: "queued", title: "Queued", match: (s) => s === "queued", tone: "neutral", terminal: false },
  { key: "running", title: "Running", match: (s) => s === "running", tone: "accent", terminal: false },
  { key: "done", title: "Done", match: (s) => s === "done" || s === "canceled", tone: "good", terminal: true },
  { key: "failed", title: "Failed", match: (s) => s === "failed", tone: "danger", terminal: true },
];

function QueueCard({ entry, now }: { entry: ReviewQueueEntry; now: number }) {
  const enc = `/repos/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/prs/${entry.number}`;
  const detailHref = `/repos/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/pr/${entry.number}`;
  const terminal = isTerminal(entry.state);
  const elapsed = fmtElapsed(durationFor(entry, now));

  return (
    <article className={`qcard state-${entry.state}`}>
      <div className="qcard-top">
        <Link to={detailHref} className="qcard-pr mono">
          <span className="qcard-repo">{entry.owner}/{entry.repo}</span>
          <span className="qcard-num">#{entry.number}</span>
        </Link>
        <span className={`chip ${entry.mode === "full" ? "accent" : "muted"} uppercase`}>{entry.mode}</span>
      </div>

      <div className="qcard-meta">
        <span className={`qdot state-${entry.state}`} aria-hidden="true" />
        <span className="qstate">
          {entry.state === "running" && entry.phase ? entry.phase : STATE_LABEL[entry.state]}
        </span>
        <span className={`qtimer mono${terminal ? " muted" : ""}`} title={terminal ? "Run duration" : "Elapsed"}>
          {elapsed}
        </span>
        {entry.attempt > 1 ? (
          <span className="chip muted" title="Re-review attempts">×{entry.attempt}</span>
        ) : null}
      </div>

      {entry.state === "failed" && entry.error ? (
        <div className="qcard-error mono" title={entry.error}>
          {entry.error}
        </div>
      ) : null}

      <div className="qcard-actions">
        {!terminal ? (
          <ActionButton
            path={`${enc}/cancel`}
            capability="triggerReview"
            variant="danger"
            successTitle="Cancel requested"
            pendingLabel="Canceling…"
            confirm="Abort this in-flight review?"
            invalidateKeys={[["queue"]]}
          >
            Cancel
          </ActionButton>
        ) : null}
        {entry.state === "failed" || entry.state === "canceled" ? (
          <ActionButton
            path={`${enc}/review`}
            body={{ mode: entry.mode }}
            capability="triggerReview"
            variant="primary"
            successTitle="Re-review queued"
            pendingLabel="Retrying…"
            invalidateKeys={[["queue"]]}
          >
            Retry
          </ActionButton>
        ) : null}
      </div>
    </article>
  );
}

export function QueuePage() {
  const query = useQueue();
  const [entries, setEntries] = useState<Record<string, ReviewQueueEntry>>({});
  const seeded = useRef(false);

  // Hydrate (and re-merge on any refetch) from the snapshot endpoint. The
  // forward-only hydrate merge guarantees a stale snapshot can never overwrite a
  // fresher live SSE update.
  useEffect(() => {
    if (!query.data) return;
    setEntries((prev) => {
      const next = { ...prev };
      for (const e of query.data.entries) next[e.key] = mergeHydrate(next[e.key], e);
      return next;
    });
    seeded.current = true;
  }, [query.data]);

  // Live transitions.
  const onEvent = useCallback((env: StreamEnvelope) => {
    if (env.topic !== "queue.updated") return;
    const e = env.payload as ReviewQueueEntry;
    setEntries((prev) => ({ ...prev, [e.key]: mergeLive(prev[e.key], e) }));
  }, []);
  useEventStream(onEvent);

  // 1s tick drives the elapsed timers on active cards.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const all = useMemo(() => Object.values(entries), [entries]);
  const activeCount = all.filter((e) => !isTerminal(e.state)).length;

  // Bucket + sort: active oldest-first (longest-waiting at top), terminal newest-first.
  const lanes = useMemo(() => {
    return LANES.map((lane) => {
      const items = all
        .filter((e) => lane.match(e.state))
        .sort((a, b) =>
          lane.terminal
            ? (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")
            : a.enqueuedAt.localeCompare(b.enqueuedAt),
        );
      return { ...lane, items };
    });
  }, [all]);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Queue" }]} />
      <PageHeader
        title="Review queue"
        subtitle={
          activeCount > 0
            ? `${activeCount} active ${pluralize(activeCount, "review")} · live`
            : "Review pipeline — updates live as PRs are reviewed"
        }
      />

      {query.isPending && !seeded.current ? (
        <LoadingState label="Loading queue…" />
      ) : query.isError && !seeded.current ? (
        <ErrorState error={query.error} />
      ) : all.length === 0 ? (
        <section className="card">
          <EmptyState
            title="Nothing in the pipeline"
            hint="Open or push to a PR in an installed repo, or trigger a re-review, and it'll appear here live."
          />
        </section>
      ) : (
        <div className="board">
          {lanes.map((lane) => (
            <section key={lane.key} className={`lane tone-${lane.tone}`}>
              <header className="lane-head">
                <span className="lane-title">{lane.title}</span>
                <span className="lane-count mono">{lane.items.length}</span>
              </header>
              <div className="lane-body">
                {lane.items.length === 0 ? (
                  <div className="lane-empty">—</div>
                ) : (
                  lane.items.map((e) => <QueueCard key={e.key} entry={e} now={now} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
