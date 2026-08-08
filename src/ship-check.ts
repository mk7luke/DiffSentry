import { REVIEW_STATUS_CONTEXT, isReviewFeedbackAddressed, type ReviewThreadSummary } from "./github.js";

/** The fields of a GitHub combined-status entry the ship check cares about. */
export interface CommitStatusLike {
  context: string;
  state: string;
  description?: string | null;
}

export interface ShipSignals {
  /** Every DiffSentry thread on the PR is resolved (and there was at least one). */
  reviewFeedbackAddressed: boolean;
  /** The latest DiffSentry review says CHANGES_REQUESTED but its threads are all resolved. */
  staleReviewState: boolean;
  /** Failing statuses that still represent real, current problems. */
  failingChecks: CommitStatusLike[];
  /** Failing statuses that are DiffSentry's own superseded verdict. */
  staleFailing: CommitStatusLike[];
  pendingChecks: CommitStatusLike[];
}

/**
 * Sort the PR's live signals into "still true" and "stale".
 *
 * DiffSentry writes its `DiffSentry` commit status once per review pass, so a
 * REQUEST_CHANGES verdict pins it to `failure` on the head SHA. Resolving the
 * threads that review opened doesn't trigger another pass — nothing does — so
 * the red X and the CHANGES_REQUESTED review both outlive the feedback they
 * represent. Reading them back as blockers is how `ship` ends up reporting
 * "Unresolved review threads: 0" and "Not ready" in the same breath.
 *
 * Only DiffSentry's own review verdict is re-derived here. `DiffSentry /
 * Pre-Merge` and third-party checks report things threads say nothing about,
 * so they stay authoritative.
 */
export function assessShipSignals(input: {
  reviewState: string;
  threads: ReviewThreadSummary;
  statuses: CommitStatusLike[];
}): ShipSignals {
  const reviewFeedbackAddressed = isReviewFeedbackAddressed(input.threads);
  const isStale = (s: CommitStatusLike) => reviewFeedbackAddressed && s.context === REVIEW_STATUS_CONTEXT;
  const allFailing = input.statuses.filter((s) => s.state === "failure" || s.state === "error");

  return {
    reviewFeedbackAddressed,
    staleReviewState: input.reviewState === "CHANGES_REQUESTED" && reviewFeedbackAddressed,
    failingChecks: allFailing.filter((s) => !isStale(s)),
    staleFailing: allFailing.filter(isStale),
    pendingChecks: input.statuses.filter((s) => s.state === "pending"),
  };
}

/** Render the `🚀 Ship Check` comment body. */
export function renderShipCheck(input: {
  botName: string;
  reviewState: string;
  threads: ReviewThreadSummary;
  signals: ShipSignals;
  /** Whether the stale `DiffSentry` status was successfully flipped back to green. */
  statusRefreshed: boolean;
  /** Blockers computed outside the signal triage, e.g. the CODEOWNERS gate. */
  extraBlockers?: string[];
}): string {
  const { botName, reviewState, threads, signals, statusRefreshed } = input;
  const { failingChecks, staleFailing, pendingChecks, staleReviewState } = signals;
  const unresolvedThreads = threads.unresolved;

  const blockers: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (reviewState === "CHANGES_REQUESTED" && !staleReviewState) {
    blockers.push("DiffSentry has requested changes (latest review).");
  }
  if (unresolvedThreads > 0) {
    warnings.push(`${unresolvedThreads} unresolved review thread${unresolvedThreads === 1 ? "" : "s"}.`);
  }
  if (failingChecks.length > 0) {
    blockers.push(
      `${failingChecks.length} failing commit status check${failingChecks.length === 1 ? "" : "s"}: ${failingChecks
        .map((s) => `\`${s.context}\``)
        .join(", ")}.`,
    );
  }
  if (pendingChecks.length > 0) {
    warnings.push(
      `${pendingChecks.length} pending check${pendingChecks.length === 1 ? "" : "s"}: ${pendingChecks
        .map((s) => `\`${s.context}\``)
        .join(", ")}.`,
    );
  }
  blockers.push(...(input.extraBlockers ?? []));

  if (staleFailing.length > 0) {
    const all = `all ${threads.botTotal} DiffSentry thread${threads.botTotal === 1 ? " is" : "s are"} resolved`;
    notes.push(
      statusRefreshed
        ? `Cleared a stale failing \`${REVIEW_STATUS_CONTEXT}\` check — ${all}. GitHub's check list may take a moment to catch up.`
        : `The failing \`${REVIEW_STATUS_CONTEXT}\` check is stale (${all}), but refreshing it failed. Re-run \`@${botName} ship\`, or push a commit to trigger a fresh review.`,
    );
  }
  if (staleReviewState) {
    notes.push(
      "The `CHANGES_REQUESTED` review is stale — every thread it opened is resolved. " +
        "GitHub still counts it against branch protection, so dismiss it if the merge button stays blocked.",
    );
  }

  const verdict =
    blockers.length === 0
      ? warnings.length === 0
        ? "🟢 **Ready to ship.** All blockers clear, no warnings."
        : "🟡 **Probably safe to ship**, but address the warnings first."
      : "🔴 **Not ready.** Address the blockers below before merging.";

  const lines: string[] = [];
  lines.push(`# 🚀 Ship Check`);
  lines.push("");
  lines.push(verdict);
  lines.push("");
  lines.push(`| Surface | Status |`);
  lines.push(`|---|---|`);
  lines.push(`| DiffSentry review | \`${reviewState}\`${staleReviewState ? " (stale)" : ""} |`);
  lines.push(`| Unresolved review threads | ${unresolvedThreads} |`);
  lines.push(
    `| Failing commit statuses | ${failingChecks.length}${staleFailing.length > 0 ? ` (+${staleFailing.length} stale)` : ""} |`,
  );
  lines.push(`| Pending commit statuses | ${pendingChecks.length} |`);

  if (blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers");
    blockers.forEach((b) => lines.push(`- ❌ ${b}`));
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    warnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    notes.forEach((n) => lines.push(`- ♻️ ${n}`));
  }

  return lines.join("\n") + `\n\n<sub>Re-run with \`@${botName} ship\` after addressing.</sub>`;
}
