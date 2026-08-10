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
  /** The repo's `reviews.thread_gate`. Must match what the sync will use. */
  gate?: ThreadGate;
}): ShipSignals {
  const reviewFeedbackAddressed = isReviewFeedbackAddressed(input.threads);
  // A failing status is stale exactly when `syncReviewCommitStatus` would clear
  // it — no blocking thread left, and DiffSentry opened at least one thread that
  // could account for the failure in the first place. These two predicates must
  // stay in lockstep: if `ship` calls a status stale that the sync then refuses
  // to clear, `ship` reports green while the check stays red.
  //
  // Deliberately not `reviewFeedbackAddressed` — that also requires every
  // nitpick to be resolved, and nitpicks never block.
  //
  // The gate has to be read here too: with `thread_gate: off` the sync ignores
  // blocking threads entirely and will clear the status, so `ship` must agree or
  // it reports a failing check in the same comment that just greened it.
  const nothingBlocking =
    (input.gate ?? "blocking") === "off" || input.threads.botUnresolvedBlocking === 0;
  const isStale = (s: CommitStatusLike) =>
    nothingBlocking && input.threads.botTotal > 0 && s.context === REVIEW_STATUS_CONTEXT;
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
  /** The repo's `reviews.thread_gate`. Must match what `assessShipSignals` saw. */
  gate?: ThreadGate;
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
  // Blocking findings gate the merge; nitpicks are worth naming but not worth
  // blocking on. Splitting them is what keeps the verdict honest — three open
  // criticals used to render the same amber as three open nitpicks.
  //
  // Under `thread_gate: off` nothing here blocks: the commit status ignores
  // threads, so calling them blockers would contradict the check this same
  // comment reports on. They stay visible as warnings.
  const gateOn = (input.gate ?? "blocking") !== "off";
  const blockingThreads = gateOn ? threads.botUnresolvedBlocking : 0;
  if (blockingThreads > 0) {
    blockers.push(`${blockingThreads} unresolved blocking finding${blockingThreads === 1 ? "" : "s"}.`);
  }
  const nonBlocking = unresolvedThreads - blockingThreads;
  if (nonBlocking > 0) {
    warnings.push(`${nonBlocking} unresolved review thread${nonBlocking === 1 ? "" : "s"}.`);
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
  lines.push(
    `| Unresolved review threads | ${unresolvedThreads}${blockingThreads > 0 ? ` (${blockingThreads} blocking)` : ""} |`,
  );
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

/** How unresolved DiffSentry threads affect the `DiffSentry` commit status. */
export type ThreadGate = "blocking" | "off";

/**
 * The single decision point for the `DiffSentry` commit status.
 *
 * Before this existed the rule was spread across three call sites that each got
 * it slightly differently — most visibly the empty-diff path, which hard-coded
 * `success` and so let a "Merge branch 'main'…" commit erase a real failure.
 *
 * Unresolved *blocking* findings outrank the review verdict: a `COMMENTED`
 * review that opened a `critical` thread is a failure until that thread is
 * resolved. Nitpicks never gate — see `isBlockingSeverity`.
 */
export function resolveReviewStatus(input: {
  approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  threads: ReviewThreadSummary;
  /** Description used when nothing blocks, e.g. "No reviewable files". */
  successDescription: string;
  gate?: ThreadGate;
}): { state: "success" | "failure"; description: string } {
  const blocking = input.threads.botUnresolvedBlocking;
  if ((input.gate ?? "blocking") === "blocking" && blocking > 0) {
    return {
      state: "failure",
      description: `${blocking} unresolved blocking finding${blocking === 1 ? "" : "s"}`,
    };
  }
  if (input.approval === "REQUEST_CHANGES") {
    return { state: "failure", description: "Changes requested" };
  }
  return { state: "success", description: input.successDescription };
}

/** What the sticky Status card shows, once the PR's live threads are folded in. */
export interface DisplayVerdict {
  state: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" | "PENDING";
  /**
   * Why the card differs from the verdict the pass itself reached. Unset when
   * the two agree, which is the common case.
   */
  reason?: string;
}

/**
 * The verdict the sticky Status card shows.
 *
 * Distinct from `resolveReviewStatus` on purpose: that one answers "may this
 * merge?", where the documented rule is that nitpicks never block. This one
 * answers "what does DiffSentry currently think of this PR?", and there an open
 * thread of *any* severity means the conversation is not finished. A card
 * reading 🟢 Approved above a row reading "Unresolved threads: 2" is the bug
 * this exists to prevent — the two halves of the same card contradicted.
 *
 * The pass's own `approval` covers only the diff it just read. A pass over a
 * two-file follow-up push legitimately returns `APPROVE` while the criticals
 * from the previous pass sit open, so the threads have to outrank it:
 *
 * - an open blocking finding renders 🔴, matching the commit status,
 * - any other unresolved thread renders 🟡 — not a merge blocker, but not a
 *   sign-off either,
 * - only a clean thread list lets `APPROVE` through as 🟢.
 *
 * Under `thread_gate: off` blocking threads stop being a merge gate, so they
 * stop rendering 🔴 too — but they still hold the card off green, because that
 * setting is about the check, not about pretending the threads are closed.
 */
export function resolveDisplayVerdict(input: {
  approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  threads: ReviewThreadSummary;
  gate?: ThreadGate;
}): DisplayVerdict {
  const { approval, threads } = input;
  const blocking = (input.gate ?? "blocking") === "off" ? 0 : threads.botUnresolvedBlocking;
  const plural = (n: number) => (n === 1 ? "" : "s");

  let state: DisplayVerdict["state"];
  let cause: string | undefined;
  if (blocking > 0) {
    state = "REQUEST_CHANGES";
    cause = `${blocking} unresolved blocking finding${plural(blocking)} still open`;
  } else if (approval === "REQUEST_CHANGES") {
    state = "REQUEST_CHANGES";
  } else if (threads.unresolved > 0) {
    state = "COMMENT";
    cause = `${threads.unresolved} unresolved thread${plural(threads.unresolved)} still open`;
  } else {
    state = approval ?? "PENDING";
  }

  // The note is worth showing only when it explains a difference. On a pass that
  // reached the same verdict on its own, it would just restate the table.
  return { state, reason: cause && approval && state !== approval ? cause : undefined };
}
