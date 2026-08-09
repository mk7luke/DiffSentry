import { REVIEW_STATUS_CONTEXT } from "./github.js";

// ─────────────────────────────────────────────────────────────────────────────
// "Has everything on this commit passed?", as a pure function.
//
// GitHub answers that in two places and neither is complete on its own. Modern
// integrations write check runs, grouped into check suites; older ones, and
// anything driving the API by hand, write commit statuses. A single PR
// routinely carries both, so a verdict has to merge the two lists.
//
// Nothing here reads the webhook payload that prompted the question. A
// `check_suite` completion says one suite of possibly five has finished, which
// is no evidence at all about the other four, so callers re-read the aggregate
// state for the head SHA and hand the whole picture to `assessChecks`.
// ─────────────────────────────────────────────────────────────────────────────

/** The fields of a check run the verdict depends on. */
export interface CheckRunLike {
  name: string;
  /** `queued` | `in_progress` | `completed`. */
  status: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` | `timed_out` | `action_required` | `stale`. */
  conclusion?: string | null;
}

/** The fields of a combined-status entry the verdict depends on. */
export interface CommitStatusLike {
  context: string;
  state: string;
}

export type ChecksState = "passed" | "pending" | "failed" | "none";

export interface ChecksVerdict {
  state: ChecksState;
  /** Checks that have not finished, named for the log line. */
  pending: string[];
  /** Checks that finished on something other than a pass. */
  failed: string[];
  /** How many checks counted toward the verdict at all. */
  counted: number;
}

/**
 * Conclusions that count as a pass.
 *
 * `neutral` and `skipped` are passes because that is how GitHub's own branch
 * protection reads them: a formatter that had nothing to reformat, or a job
 * skipped by a path filter, is not a reason to withhold anything. Every other
 * terminal conclusion, `cancelled` and `stale` included, is treated as a
 * failure. A cancelled run on the *current* head is a run whose result nobody
 * has, and guessing in the optimistic direction is the wrong default here.
 */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Whether a check is one DiffSentry writes about itself.
 *
 * These are deliberately left out of the verdict, and the reasoning is worth
 * writing down because counting them looks more rigorous than it is.
 *
 * The `DiffSentry` status carries the app's own review verdict, and since the
 * thread gate landed it sits at `failure` for as long as a critical or major
 * finding is unresolved. Counting it would mean release notes only ever appear
 * on a PR whose every blocking finding has been closed. That is a merge gate.
 * Release notes describe what a PR does; they are not an approval of it, and
 * withholding them behind our own verdict makes the feature self-referential:
 * DiffSentry deciding whether DiffSentry may speak.
 *
 * There is a mechanical reason too. Our status is the one check on the SHA that
 * our own actions move: resolving a thread runs the status sync, which writes
 * a status, which raises a `status` event that arrives straight back here.
 * Leaving it out of the sum means DiffSentry can never be the check that tips
 * the aggregate green, so that path cannot feed itself.
 *
 * Matching is on the exact context or the `DiffSentry / ` prefix the app uses
 * for its sub-checks (`DiffSentry / Pre-Merge`), rather than a bare
 * `startsWith`, so a repo's own "DiffSentry integration tests" job still counts.
 */
export function isDiffSentryCheck(name: string): boolean {
  return name === REVIEW_STATUS_CONTEXT || name.startsWith(`${REVIEW_STATUS_CONTEXT} / `);
}

/**
 * Merge check runs and commit statuses into one verdict for a head SHA.
 *
 * `none` is its own state rather than a pass. A repo with no CI at all has
 * vacuously passed everything, and treating that as green would fire on every
 * PR in it, which is not what anyone enabling this asked for.
 *
 * Failures outrank pending: once something has gone red the PR is not on its
 * way to green, whatever is still running, and saying so makes the log line
 * useful instead of reporting the same "still waiting" forever.
 *
 * Callers are expected to have asked GitHub for the latest run per check name
 * (`checks.listForRef` does that by default) and for the collapsed combined
 * status. Re-runs and superseded statuses are not de-duplicated here.
 */
export function assessChecks(input: {
  statuses: CommitStatusLike[];
  checkRuns: CheckRunLike[];
}): ChecksVerdict {
  const pending: string[] = [];
  const failed: string[] = [];
  let counted = 0;

  for (const run of input.checkRuns) {
    if (isDiffSentryCheck(run.name)) continue;
    counted++;
    if (run.status !== "completed") {
      pending.push(run.name);
      continue;
    }
    // A completed run with no conclusion is GitHub telling us it does not know.
    // Fail-safe: an unreadable result withholds the notes rather than passing.
    if (!PASSING_CONCLUSIONS.has(run.conclusion ?? "")) failed.push(run.name);
  }

  for (const status of input.statuses) {
    if (isDiffSentryCheck(status.context)) continue;
    counted++;
    if (status.state === "pending") {
      pending.push(status.context);
      continue;
    }
    if (status.state !== "success") failed.push(status.context);
  }

  if (counted === 0) return { state: "none", pending, failed, counted };
  if (failed.length > 0) return { state: "failed", pending, failed, counted };
  if (pending.length > 0) return { state: "pending", pending, failed, counted };
  return { state: "passed", pending, failed, counted };
}
