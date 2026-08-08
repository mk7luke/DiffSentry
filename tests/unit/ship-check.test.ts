import { describe, it, expect, vi } from "vitest";
import { GitHubClient, isReviewFeedbackAddressed, type ReviewThreadSummary } from "../../src/github.js";
import { assessShipSignals, renderShipCheck, type CommitStatusLike } from "../../src/ship-check.js";
import { Reviewer } from "../../src/reviewer.js";

const BOT = "diffsentry";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, ...over };
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
      threads: threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1 }),
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
  function node(opts: { resolved: boolean; author: string; type?: string }) {
    return {
      id: `t-${opts.author}-${opts.resolved}`,
      isResolved: opts.resolved,
      path: "src/a.ts",
      comments: { nodes: [{ author: { login: opts.author, __typename: opts.type ?? "Bot" } }] },
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
    ).toEqual({ total: 3, unresolved: 2, botTotal: 2, botUnresolved: 1 });
  });

  it("reports zero bot threads on a PR DiffSentry never commented on", async () => {
    expect(await summarize([node({ resolved: false, author: "luke", type: "User" })])).toEqual({
      total: 1,
      unresolved: 1,
      botTotal: 0,
      botUnresolved: 0,
    });
  });

  it("counts an all-resolved bot review as addressed", async () => {
    const summary = await summarize([
      node({ resolved: true, author: "diffsentry[bot]" }),
      node({ resolved: true, author: "diffsentry[bot]" }),
    ]);
    expect(summary).toEqual({ total: 2, unresolved: 0, botTotal: 2, botUnresolved: 0 });
    expect(isReviewFeedbackAddressed(summary)).toBe(true);
  });
});

describe("Reviewer.refreshReviewCommitStatus", () => {
  function reviewerWith(github: Record<string, unknown>) {
    // Bypass the constructor: it builds real AI providers and a GitHub client,
    // none of which this method touches.
    const reviewer = Object.create(Reviewer.prototype) as Reviewer;
    (reviewer as unknown as { github: unknown }).github = github;
    return reviewer;
  }

  const base = () => ({
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getCommitStatusState: vi.fn().mockResolvedValue("failure"),
    summarizeReviewThreads: vi.fn().mockResolvedValue(ALL_ADDRESSED),
    setCommitStatus: vi.fn().mockResolvedValue(undefined),
  });

  it("flips a stale failing status back to success", async () => {
    const github = base();
    const refreshed = await reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7);

    expect(refreshed).toBe(true);
    expect(github.setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "success", "All review threads resolved", "DiffSentry",
    );
  });

  it("leaves the status alone while a DiffSentry thread is unresolved", async () => {
    const github = base();
    github.summarizeReviewThreads.mockResolvedValue(threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1 }));

    expect(await reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7)).toBe(false);
    expect(github.setCommitStatus).not.toHaveBeenCalled();
  });

  it("does nothing when the status is already green", async () => {
    const github = base();
    github.getCommitStatusState.mockResolvedValue("success");

    expect(await reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7)).toBe(false);
    expect(github.summarizeReviewThreads).not.toHaveBeenCalled();
    expect(github.setCommitStatus).not.toHaveBeenCalled();
  });

  it("does nothing when we never posted the status at all", async () => {
    // How `reviews.commit_status: false` is honoured without loading config.
    const github = base();
    github.getCommitStatusState.mockResolvedValue(null);

    expect(await reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7)).toBe(false);
    expect(github.setCommitStatus).not.toHaveBeenCalled();
  });

  it("reuses a caller-supplied head SHA and thread summary", async () => {
    const github = base();
    const refreshed = await reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7, {
      headSha: "deadbee",
      threads: ALL_ADDRESSED,
    });

    expect(refreshed).toBe(true);
    expect(github.getHeadSha).not.toHaveBeenCalled();
    expect(github.summarizeReviewThreads).not.toHaveBeenCalled();
    expect(github.getCommitStatusState).toHaveBeenCalledWith(1, "o", "r", "deadbee", "DiffSentry");
  });

  it("swallows GitHub failures rather than breaking the caller", async () => {
    const github = base();
    github.setCommitStatus.mockRejectedValue(new Error("403"));

    await expect(reviewerWith(github).refreshReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
  });
});
