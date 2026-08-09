import { describe, it, expect } from "vitest";
import { GitHubClient, isReviewFeedbackAddressed, type ReviewThreadSummary } from "../../src/github.js";
import { assessShipSignals, renderShipCheck, resolveReviewStatus, type CommitStatusLike } from "../../src/ship-check.js";
import { DIFFSENTRY_COMMENT_FOOTER } from "../../src/thread-severity.js";

const BOT = "diffsentry";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/** The reported bug: DiffSentry opened threads, they all got resolved, and the
 *  `DiffSentry` status is still stuck on the `failure` the review pass wrote. */
const ALL_ADDRESSED = threads({ total: 2, unresolved: 0, botTotal: 2, botUnresolved: 0 });
const STALE_FAILURE: CommitStatusLike = { context: "DiffSentry", state: "failure", description: "Changes requested" };

describe("isReviewFeedbackAddressed", () => {
  it("is true once every DiffSentry thread is resolved", () => {
    expect(isReviewFeedbackAddressed(ALL_ADDRESSED)).toBe(true);
  });

  it("is false while a DiffSentry thread is still open", () => {
    expect(isReviewFeedbackAddressed(threads({ total: 2, unresolved: 1, botTotal: 2, botUnresolved: 1 }))).toBe(false);
  });

  it("is false when DiffSentry never opened a thread", () => {
    // Zero-of-zero must not read as "addressed" — a failing status on a PR the
    // bot never commented on is about something threads can't speak to.
    expect(isReviewFeedbackAddressed(threads())).toBe(false);
  });

  it("ignores unresolved threads that belong to humans", () => {
    expect(isReviewFeedbackAddressed(threads({ total: 3, unresolved: 1, botTotal: 2, botUnresolved: 0 }))).toBe(true);
  });
});

describe("assessShipSignals", () => {
  it("treats a failing DiffSentry status as stale when its threads are resolved", () => {
    const signals = assessShipSignals({
      reviewState: "COMMENTED",
      threads: ALL_ADDRESSED,
      statuses: [STALE_FAILURE],
    });

    expect(signals.staleFailing).toEqual([STALE_FAILURE]);
    expect(signals.failingChecks).toEqual([]);
  });

  it("keeps the DiffSentry status as a real failure while threads are open", () => {
    const signals = assessShipSignals({
      reviewState: "CHANGES_REQUESTED",
      threads: threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      statuses: [STALE_FAILURE],
    });

    expect(signals.failingChecks).toEqual([STALE_FAILURE]);
    expect(signals.staleFailing).toEqual([]);
    expect(signals.staleReviewState).toBe(false);
  });

  it("never discounts checks DiffSentry doesn't own", () => {
    const ci: CommitStatusLike = { context: "CI / Backend", state: "failure" };
    const preMerge: CommitStatusLike = { context: "DiffSentry / Pre-Merge", state: "failure" };
    const signals = assessShipSignals({
      reviewState: "COMMENTED",
      threads: ALL_ADDRESSED,
      statuses: [ci, preMerge, STALE_FAILURE],
    });

    expect(signals.failingChecks).toEqual([ci, preMerge]);
    expect(signals.staleFailing).toEqual([STALE_FAILURE]);
  });

  it("marks a CHANGES_REQUESTED review stale once its threads are resolved", () => {
    const signals = assessShipSignals({ reviewState: "CHANGES_REQUESTED", threads: ALL_ADDRESSED, statuses: [] });
    expect(signals.staleReviewState).toBe(true);
  });

  it("counts error states as failing and pending separately", () => {
    const errored: CommitStatusLike = { context: "CI / Deploy", state: "error" };
    const pending: CommitStatusLike = { context: "CI / Slow", state: "pending" };
    const signals = assessShipSignals({
      reviewState: "COMMENTED",
      threads: threads(),
      statuses: [errored, pending, { context: "CI / Fast", state: "success" }],
    });

    expect(signals.failingChecks).toEqual([errored]);
    expect(signals.pendingChecks).toEqual([pending]);
  });
});

describe("renderShipCheck", () => {
  function render(over: Partial<Parameters<typeof renderShipCheck>[0]> = {}) {
    const reviewState = over.reviewState ?? "COMMENTED";
    const t = over.threads ?? ALL_ADDRESSED;
    return renderShipCheck({
      botName: BOT,
      reviewState,
      threads: t,
      signals: over.signals ?? assessShipSignals({ reviewState, threads: t, statuses: [STALE_FAILURE] }),
      statusRefreshed: over.statusRefreshed ?? true,
      extraBlockers: over.extraBlockers,
    });
  }

  it("clears the verdict when the only failure was the stale DiffSentry check", () => {
    const body = render();
    expect(body).toContain("🟢 **Ready to ship.**");
    expect(body).not.toContain("## Blockers");
  });

  it("explains the refresh instead of silently dropping the check", () => {
    const body = render();
    expect(body).toContain("## Notes");
    expect(body).toContain("Cleared a stale failing `DiffSentry` check");
    expect(body).toContain("| Failing commit statuses | 0 (+1 stale) |");
  });

  it("tells the author how to recover when the refresh failed", () => {
    const body = render({ statusRefreshed: false });
    expect(body).toContain("refreshing it failed");
    expect(body).toContain("@diffsentry ship");
    // Still not a blocker — the signal is stale either way.
    expect(body).toContain("🟢 **Ready to ship.**");
  });

  it("stays red when a real check fails alongside the stale one", () => {
    const reviewState = "COMMENTED";
    const body = render({
      signals: assessShipSignals({
        reviewState,
        threads: ALL_ADDRESSED,
        statuses: [STALE_FAILURE, { context: "CI / Backend", state: "failure" }],
      }),
    });

    expect(body).toContain("🔴 **Not ready.**");
    expect(body).toContain("1 failing commit status check: `CI / Backend`.");
  });

  it("flags a stale CHANGES_REQUESTED review without blocking on it", () => {
    const body = render({ reviewState: "CHANGES_REQUESTED" });
    expect(body).toContain("| DiffSentry review | `CHANGES_REQUESTED` (stale) |");
    expect(body).not.toContain("DiffSentry has requested changes");
    expect(body).toContain("dismiss it if the merge button stays blocked");
  });

  it("still blocks on a live CHANGES_REQUESTED review", () => {
    const open = threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1 });
    const body = render({ reviewState: "CHANGES_REQUESTED", threads: open });
    expect(body).toContain("🔴 **Not ready.**");
    expect(body).toContain("DiffSentry has requested changes (latest review).");
    expect(body).toContain("1 unresolved review thread.");
  });

  it("keeps externally computed blockers such as the CODEOWNERS gate", () => {
    const body = render({ extraBlockers: ["No CODEOWNERS approval yet — needs review from one of: @luke."] });
    expect(body).toContain("🔴 **Not ready.**");
    expect(body).toContain("No CODEOWNERS approval yet");
  });
});

describe("GitHubClient.summarizeReviewThreads", () => {
  function node(opts: { resolved: boolean; author: string; type?: string; body?: string }) {
    return {
      id: `t-${opts.author}-${opts.resolved}`,
      isResolved: opts.resolved,
      path: "src/a.ts",
      comments: {
        // Defaults to a pre-severity-marker DiffSentry comment: no marker, but
        // carrying the footer that identifies it as ours.
        nodes: [{ body: opts.body ?? DIFFSENTRY_COMMENT_FOOTER, author: { login: opts.author, __typename: opts.type ?? "Bot" } }],
      },
    };
  }

  async function summarize(nodes: unknown[]) {
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    Object.assign(client, { config: { botName: "diffsentry" } });
    (client as unknown as { getInstallationOctokit: unknown }).getInstallationOctokit = async () => ({
      graphql: async () => ({
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } },
      }),
    });
    return client.summarizeReviewThreads(1, "o", "r", 7);
  }

  it("splits resolution counts by author", async () => {
    expect(
      await summarize([
        node({ resolved: true, author: "diffsentry[bot]" }),
        node({ resolved: false, author: "diffsentry[bot]" }),
        node({ resolved: false, author: "luke", type: "User" }),
      ]),
    ).toEqual({ total: 3, unresolved: 2, botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 1 });
  });

  it("does not let another vendor's bot thread gate the DiffSentry check", async () => {
    // isOurBotThread matches any *[bot] login so old deployments can
    // self-resolve. Harmless when it only fed a number in a comment; now that it
    // gates a commit status, a Copilot/Sonar/Codecov review comment must not red
    // the check for a finding DiffSentry never made.
    expect(
      await summarize([node({ resolved: false, author: "copilot[bot]", body: "Consider renaming this." })]),
    ).toMatchObject({ botUnresolved: 1, botUnresolvedBlocking: 0 });
  });

  it("reports zero bot threads on a PR DiffSentry never commented on", async () => {
    expect(await summarize([node({ resolved: false, author: "luke", type: "User" })])).toEqual({
      total: 1,
      unresolved: 1,
      botTotal: 0,
      botUnresolved: 0,
      botUnresolvedBlocking: 0,
    });
  });

  it("counts an all-resolved bot review as addressed", async () => {
    const summary = await summarize([
      node({ resolved: true, author: "diffsentry[bot]" }),
      node({ resolved: true, author: "diffsentry[bot]" }),
    ]);
    expect(summary).toEqual({ total: 2, unresolved: 0, botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 });
    expect(isReviewFeedbackAddressed(summary)).toBe(true);
  });
});

// Reviewer.syncReviewCommitStatus (formerly refreshReviewCommitStatus) has its
// own dedicated coverage in tests/unit/status-sync.test.ts, including the
// bidirectional cases the old one-directional method couldn't reach.

describe("resolveReviewStatus", () => {
  const clean = threads({ total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0 });
  const oneBlocking = threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 });
  const onlyNits = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 0 });

  it("fails on an unresolved blocking thread even when the review only commented", () => {
    // The reported bug: COMMENTED + open threads used to be green.
    const r = resolveReviewStatus({ approval: "COMMENT", threads: oneBlocking, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("1 unresolved blocking finding");
  });

  it("pluralises the blocking description", () => {
    const many = threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 3 });
    const r = resolveReviewStatus({ threads: many, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("3 unresolved blocking findings");
  });

  it("ranks an unresolved blocking thread above the REQUEST_CHANGES verdict", () => {
    // Both rules fire at once. Only correct precedence produces the blocking
    // description — swap the two `if` blocks and this is the test that catches it.
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: oneBlocking, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("1 unresolved blocking finding");
  });

  it("stays green when only nitpicks are open", () => {
    const r = resolveReviewStatus({ approval: "COMMENT", threads: onlyNits, successDescription: "Review complete with comments" });
    expect(r.state).toBe("success");
    expect(r.description).toBe("Review complete with comments");
  });

  it("still fails on REQUEST_CHANGES with no open threads", () => {
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: clean, successDescription: "ok" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("Changes requested");
  });

  it("uses the caller's success description when nothing blocks", () => {
    const r = resolveReviewStatus({ threads: clean, successDescription: "No reviewable files" });
    expect(r).toEqual({ state: "success", description: "No reviewable files" });
  });

  it("works with no approval at all (the empty-diff path has no verdict)", () => {
    expect(resolveReviewStatus({ threads: oneBlocking, successDescription: "No reviewable files" }).state).toBe("failure");
  });

  it("ignores threads entirely when the gate is off", () => {
    const r = resolveReviewStatus({ approval: "COMMENT", threads: oneBlocking, successDescription: "ok", gate: "off" });
    expect(r).toEqual({ state: "success", description: "ok" });
  });

  it("still honours REQUEST_CHANGES when the gate is off", () => {
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: clean, successDescription: "ok", gate: "off" });
    expect(r.state).toBe("failure");
  });

  it("suppresses the blocking rule but not REQUEST_CHANGES when the gate is off and threads are open", () => {
    // gate: "off" must silence only the blocking-threads rule — the verdict
    // rule underneath it still has to fire, with its own description.
    const r = resolveReviewStatus({ approval: "REQUEST_CHANGES", threads: oneBlocking, successDescription: "ok", gate: "off" });
    expect(r.state).toBe("failure");
    expect(r.description).toBe("Changes requested");
  });

  it("defaults to the blocking gate when none is given", () => {
    expect(resolveReviewStatus({ threads: oneBlocking, successDescription: "ok" }).state).toBe("failure");
  });
});

describe("renderShipCheck — blocking threads", () => {
  const base = {
    botName: BOT,
    reviewState: "COMMENTED",
    statusRefreshed: false,
  };

  it("files a blocking thread as a blocker and reports Not ready", () => {
    // The reported bug: 3 unresolved threads rendered 🟡 "Probably safe to ship".
    const t = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });

    expect(body).toContain("🔴 **Not ready.**");
    expect(body).toContain("## Blockers");
    expect(body).toContain("2 unresolved blocking findings");
  });

  it("files nitpick-only threads as a warning and stays amber", () => {
    const t = threads({ total: 2, unresolved: 2, botTotal: 2, botUnresolved: 2, botUnresolvedBlocking: 0 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });

    expect(body).toContain("🟡 **Probably safe to ship**");
    expect(body).not.toContain("## Blockers");
    expect(body).toContain("2 unresolved review threads");
  });

  it("does not file blocking findings as blockers when the gate is off", () => {
    // With thread_gate: off the sync clears the check, so calling these blockers
    // would contradict the very check this comment reports on. They stay visible
    // as warnings.
    const t = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [], gate: "off" }),
      gate: "off",
    });

    expect(body).not.toContain("## Blockers");
    expect(body).not.toContain("unresolved blocking finding");
    expect(body).toContain("🟡 **Probably safe to ship**");
    expect(body).toContain("3 unresolved review threads.");
  });

  it("shows the blocking breakdown in the status table", () => {
    const t = threads({ total: 3, unresolved: 3, botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 });
    const body = renderShipCheck({
      ...base,
      threads: t,
      signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [] }),
    });
    expect(body).toContain("| Unresolved review threads | 3 (2 blocking) |");
  });
});

describe("assessShipSignals — blocking threads", () => {
  it("does not call a failing status stale while a blocking thread is open", () => {
    // botUnresolved is 0 for bot threads that were resolved, but an unreadable
    // legacy thread still counts as blocking — the status is genuinely failing.
    const t = threads({ total: 1, unresolved: 1, botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 1 });
    const signals = assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [STALE_FAILURE] });
    expect(signals.staleFailing).toEqual([]);
    expect(signals.failingChecks).toEqual([STALE_FAILURE]);
  });

  it("still calls a failing status stale when nothing blocks", () => {
    const signals = assessShipSignals({ reviewState: "COMMENTED", threads: ALL_ADDRESSED, statuses: [STALE_FAILURE] });
    expect(signals.staleFailing).toEqual([STALE_FAILURE]);
  });
});
