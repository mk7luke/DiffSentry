import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { reviewQueue } from "./queue.js";
import {
  upsertReviewJob,
  markReviewJobTerminal,
  listInFlightReviewJobs,
} from "../storage/dao.js";
import { isShuttingDown } from "../shutdown.js";

// ─────────────────────────────────────────────────────────────────────────────
// Durable review job-runner — the resilience layer around a single review.
//
// It wraps reviewer.handlePullRequest with three guarantees the bare call lacks:
//   1. Durability — each attempt is persisted to review_jobs (best-effort), so a
//      restart can re-enqueue work that was in-flight when the process died.
//      recoverInFlightJobs() is the boot-time replay.
//   2. Bounded retry with backoff — a review that fails on a *transient* error
//      (network blip, GitHub 5xx/429, AI timeout) is retried a few times with
//      exponential backoff before giving up. Non-transient errors fail fast.
//   3. Dead-lettering — once the retries are exhausted the PR's board card is
//      promoted to the terminal `dead_letter` state so operators can see the
//      review was abandoned, not merely slow.
//
// The in-memory reviewQueue board is unchanged: handlePullRequest still owns its
// per-attempt card (each retry re-enqueues, bumping the attempt counter). This
// runner only adds the durable shadow + the retry/dead-letter envelope around
// it. Every durable write degrades to a clean no-op when persistence is off, so
// the runner still retries and dead-letters in memory without a database.
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of Reviewer the job-runner drives — matches WebhookReviewer's. */
export interface JobReviewer {
  handlePullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    mode: "full" | "incremental",
  ): Promise<void>;
}

export interface ReviewJobSpec {
  reviewer: JobReviewer;
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  mode: "full" | "incremental";
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** Total attempts (initial + retries) before dead-lettering. Min 1, env-tunable. */
function maxAttempts(): number {
  const raw = Number.parseInt(process.env.REVIEW_RETRY_MAX_ATTEMPTS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_ATTEMPTS;
}

/** Base backoff in ms; the Nth retry waits base · 2^(N-1), capped. Env-tunable. */
function baseBackoffMs(): number {
  const raw = Number.parseInt(process.env.REVIEW_RETRY_BASE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BASE_BACKOFF_MS;
}

/** Network-layer error codes that warrant a retry. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_MESSAGE_HINTS = [
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "socket hang up",
  "network",
  "fetch failed",
  "temporarily unavailable",
  "service unavailable",
  "rate limit",
  "too many requests",
];

/** Read an HTTP-ish status off an error (Octokit RequestError, fetch wrappers). */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
  return typeof s === "number" ? s : undefined;
}

/**
 * Classify an error thrown by a review attempt as transient (worth retrying) or
 * permanent (fail fast). Transient = network blips, GitHub/AI 5xx + 429, request
 * timeouts, and AbortError raised by an AI client's own timeout. NOTE: our cancel
 * path never reaches here — handlePullRequest swallows an operator/superseded
 * abort and returns without throwing — so a thrown AbortError is an upstream
 * timeout, not a cancellation.
 */
export function isTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;

  const status = statusOf(err);
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;

  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_MESSAGE_HINTS.some((hint) => msg.includes(hint));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Unref'd sleep so a pending backoff can never by itself keep the process up. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Run one review with durability + bounded retry + dead-lettering. Fire-and-
 * forget from the webhook dispatch path (and from boot recovery). Resolves once
 * the review reaches a terminal outcome (done / failed / dead-letter / deferred
 * to next boot). Never rejects — every failure mode is handled internally.
 */
export async function runReviewJob(spec: ReviewJobSpec): Promise<void> {
  const { reviewer, installationId, owner, repo, number, mode } = spec;
  const runId = randomUUID();
  const max = maxAttempts();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= max; attempt++) {
    // Persist this attempt as in-flight BEFORE running it, so a crash mid-review
    // leaves a `running` row for boot recovery to find.
    upsertReviewJob({
      runId,
      owner,
      repo,
      number,
      mode,
      installationId,
      state: "running",
      attempts: attempt,
      lastError: lastErr != null ? errorMessage(lastErr) : null,
    });

    try {
      await reviewer.handlePullRequest(installationId, owner, repo, number, mode);
      // Returned without throwing → completed, skipped by a gate, or was aborted
      // (operator cancel / superseded). All mean "don't re-run on boot": clear
      // the durable row. The run_id guard makes a superseded clear a no-op.
      markReviewJobTerminal({ owner, repo, number, runId, state: "done" });
      return;
    } catch (err) {
      lastErr = err;
      const transient = isTransientError(err);
      logger.warn(
        { err, owner, repo, pr: number, attempt, max, transient },
        "Review job attempt failed",
      );

      if (!transient) {
        // Permanent failure — handlePullRequest's own finally already marked the
        // board card `failed`. Record the durable failure and stop.
        markReviewJobTerminal({ owner, repo, number, runId, state: "failed", lastError: errorMessage(err) });
        return;
      }

      if (attempt >= max) break; // exhausted → dead-letter below

      // Don't sleep on a retry while the process is tearing down: leave the
      // durable row `running` so the next boot re-enqueues it.
      if (isShuttingDown()) {
        logger.info({ owner, repo, pr: number }, "Shutting down — deferring review retry to next boot");
        return;
      }

      const delay = Math.min(baseBackoffMs() * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      logger.info({ owner, repo, pr: number, attempt, delay }, "Retrying review after transient failure");
      await sleep(delay);

      // Re-check after the backoff: shutdown may have begun while we slept.
      if (isShuttingDown()) return;
    }
  }

  // Bounded retries exhausted on a transient error → dead-letter.
  const msg = errorMessage(lastErr);
  logger.error({ owner, repo, pr: number, attempts: max, err: lastErr }, "Review dead-lettered after exhausting retries");
  reviewQueue.markDeadLetter(owner, repo, number, msg);
  markReviewJobTerminal({ owner, repo, number, runId, state: "dead_letter", lastError: msg });
}

/**
 * Re-enqueue every review that was in-flight when the process last stopped.
 * Called once at boot (after persistence is open). Each recovered job runs
 * through the full runReviewJob envelope again — fresh run_id, fresh retry
 * budget. Returns the number recovered (0 when persistence is off / nothing was
 * pending). Fire-and-forget per job so a slow recovery never blocks the listener.
 */
export function recoverInFlightJobs(reviewer: JobReviewer): number {
  const jobs = listInFlightReviewJobs();
  if (jobs.length === 0) return 0;
  logger.info({ count: jobs.length }, "Recovering in-flight review jobs after restart");
  for (const job of jobs) {
    void runReviewJob({
      reviewer,
      installationId: job.installation_id,
      owner: job.owner,
      repo: job.repo,
      number: job.number,
      mode: job.mode,
    }).catch((err) => logger.error({ err, key: job.key }, "Recovered review job failed"));
  }
  return jobs.length;
}
