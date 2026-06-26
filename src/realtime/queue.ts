import { recordEvent } from "../storage/dao.js";
import { logger } from "../logger.js";
import { bus, type ReviewQueueEntry, type ReviewQueueState } from "./bus.js";

// ─────────────────────────────────────────────────────────────────────────────
// Review queue registry — the live board behind GET /api/v1/queue.
//
// This is the richer successor to reviewer.ts's bare `activeReviews`
// Map<key, AbortController>: it still owns the AbortController that powers
// cancellation, but also tracks each review's lifecycle (queued → running →
// done | failed | canceled) plus the timestamps the dashboard needs for live
// elapsed timers. Every transition publishes `queue.updated` on the bus so
// connected dashboards animate without polling, and every terminal outcome is
// persisted to the events table (best-effort; no-op when the DB is disabled).
//
// Single process / single container: this is process-local state, exactly like
// the bus. It is deliberately not durable — the events table is the permanent
// record of what happened; this registry is only the live view of what's
// happening now.
//
// Concurrency note: each review is keyed by PR. A second review starting for
// the same PR (e.g. two rapid `synchronize` webhooks) supersedes the first —
// its AbortController is aborted and a fresh attempt is registered. The handle
// returned by enqueue() is pinned to its attempt number, so a superseded
// review can never finalize the entry that replaced it.
// ─────────────────────────────────────────────────────────────────────────────

/** How many terminal (done/failed/canceled) cards to retain for the board.
 * Active entries are never pruned; only the finished tail is bounded. */
const TERMINAL_RETENTION = 40;

function isTerminal(state: ReviewQueueState): boolean {
  return state === "done" || state === "failed" || state === "canceled";
}

/**
 * The control surface returned to a single in-flight review. All mutators are
 * pinned to the attempt that created them, so they no-op if this review has
 * been superseded or already finalized (e.g. canceled out-of-band).
 */
export interface ReviewHandle {
  /** The signal to thread through the review; aborts when cancel() is called. */
  readonly signal: AbortSignal;
  /** Transition queued → running (real work has begun). */
  start(phase?: string): void;
  /** Update the running card's phase label. */
  phase(phase: string): void;
  /** Terminal: completed successfully (or a clean no-op skip). */
  complete(): void;
  /** Terminal: threw. */
  fail(error: string): void;
  /** Terminal: aborted (signal already tripped). */
  canceled(): void;
}

class ReviewQueue {
  private readonly entries = new Map<string, ReviewQueueEntry>();
  private readonly controllers = new Map<string, AbortController>();

  private keyFor(owner: string, repo: string, num: number): string {
    return `${owner}/${repo}#${num}`;
  }

  /**
   * Register a new review as queued and return its control handle. Any prior
   * in-flight review for the same PR is superseded (its controller aborted).
   */
  enqueue(owner: string, repo: string, num: number, mode: "full" | "incremental"): ReviewHandle {
    const key = this.keyFor(owner, repo, num);
    const prior = this.controllers.get(key);
    if (prior && !prior.signal.aborted) prior.abort();

    const controller = new AbortController();
    this.controllers.set(key, controller);
    const attempt = (this.entries.get(key)?.attempt ?? 0) + 1;
    const entry: ReviewQueueEntry = {
      key,
      owner,
      repo,
      number: num,
      mode,
      state: "queued",
      phase: null,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      attempt,
    };
    this.entries.set(key, entry);
    this.emit(entry);

    return {
      signal: controller.signal,
      start: (phase) =>
        this.transition(key, attempt, (e) => {
          e.state = "running";
          e.startedAt = new Date().toISOString();
          e.phase = phase ?? null;
        }),
      phase: (phase) =>
        this.transition(key, attempt, (e) => {
          e.phase = phase;
        }),
      complete: () => this.finalize(key, attempt, "done"),
      fail: (error) => this.finalize(key, attempt, "failed", error),
      canceled: () => this.finalize(key, attempt, "canceled"),
    };
  }

  /**
   * Abort an in-flight review and mark it canceled. The public cancel path,
   * driven by the /cancel command endpoint and the PR-closed webhook. Safe to
   * call when nothing is running (no-op).
   */
  cancel(owner: string, repo: string, num: number): void {
    const key = this.keyFor(owner, repo, num);
    const controller = this.controllers.get(key);
    if (controller && !controller.signal.aborted) controller.abort();
    const entry = this.entries.get(key);
    if (entry && !isTerminal(entry.state)) {
      this.finalize(key, entry.attempt, "canceled");
    }
  }

  /**
   * Abort every in-flight review and mark each canceled — the graceful-shutdown
   * path. Reuses the same per-PR AbortController + finalize machinery as the
   * single-PR cancel(), so a review threading the signal unwinds exactly as it
   * would on an out-of-band cancel. Returns how many active reviews were
   * canceled; a no-op (returns 0) when nothing is running. Safe to call twice.
   */
  cancelAll(): number {
    let canceled = 0;
    // Snapshot the controller keys first: finalize() mutates both maps as it
    // runs, so iterating the live map directly would be unsafe.
    for (const key of Array.from(this.controllers.keys())) {
      const controller = this.controllers.get(key);
      if (controller && !controller.signal.aborted) controller.abort();
      const entry = this.entries.get(key);
      if (entry && !isTerminal(entry.state)) {
        this.finalize(key, entry.attempt, "canceled");
        canceled++;
      }
    }
    return canceled;
  }

  /**
   * The board snapshot: active entries first (oldest first), then the most
   * recent terminal cards (newest first).
   */
  snapshot(): ReviewQueueEntry[] {
    const all = Array.from(this.entries.values());
    const active = all
      .filter((e) => !isTerminal(e.state))
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
    const terminal = all
      .filter((e) => isTerminal(e.state))
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
    return [...active, ...terminal.slice(0, TERMINAL_RETENTION)];
  }

  /** Apply a mutation to an entry iff it still owns the given attempt and is
   * not already terminal, then publish the change. */
  private transition(key: string, attempt: number, mutate: (e: ReviewQueueEntry) => void): void {
    const entry = this.entries.get(key);
    if (!entry || entry.attempt !== attempt || isTerminal(entry.state)) return;
    mutate(entry);
    this.emit(entry);
  }

  private finalize(key: string, attempt: number, state: ReviewQueueState, error?: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.attempt !== attempt || isTerminal(entry.state)) return;
    entry.state = state;
    entry.phase = null;
    entry.finishedAt = new Date().toISOString();
    entry.error = error ?? null;
    this.controllers.delete(key);
    this.emit(entry);

    // Persist the terminal outcome (best-effort; no-op when DB disabled).
    const startMs = Date.parse(entry.startedAt ?? entry.enqueuedAt);
    const durationMs = Number.isFinite(startMs) ? Date.parse(entry.finishedAt) - startMs : null;
    recordEvent({
      owner: entry.owner,
      repo: entry.repo,
      number: entry.number,
      kind: `review.${state}`,
      payload: { mode: entry.mode, attempt: entry.attempt, durationMs, error: entry.error },
    });
    this.prune();
  }

  /** Bound the retained terminal tail so the registry can't grow without limit. */
  private prune(): void {
    const terminal = Array.from(this.entries.values())
      .filter((e) => isTerminal(e.state))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    const excess = terminal.length - TERMINAL_RETENTION;
    for (let i = 0; i < excess; i++) this.entries.delete(terminal[i].key);
  }

  private emit(entry: ReviewQueueEntry): void {
    // Publish a shallow copy so later mutations don't alias what subscribers saw.
    try {
      bus.publish("queue.updated", { ...entry });
    } catch (err) {
      logger.debug({ err, key: entry.key }, "reviewQueue.emit failed");
    }
  }
}

/** Process-wide singleton. Import this everywhere — do not construct your own.
 * Pinned to globalThis (like the bus) so the board's in-memory state can't be
 * split across duplicate module instances — a no-op in the normal runtime. */
const queueGlobal = globalThis as unknown as { __diffsentryReviewQueue?: ReviewQueue };
export const reviewQueue: ReviewQueue =
  queueGlobal.__diffsentryReviewQueue ?? (queueGlobal.__diffsentryReviewQueue = new ReviewQueue());
