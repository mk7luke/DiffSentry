import { describe, it, expect, vi } from "vitest";
import { Reviewer } from "../../src/reviewer.js";
import type { ReviewThreadSummary } from "../../src/github.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/** A Reviewer with only the GitHub calls syncReviewCommitStatus touches. */
function reviewerWith(opts: { currentState: string | null; threads: ReviewThreadSummary }) {
  const setCommitStatus = vi.fn().mockResolvedValue(undefined);
  const github = {
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getCommitStatusState: vi.fn().mockResolvedValue(opts.currentState),
    summarizeReviewThreads: vi.fn().mockResolvedValue(opts.threads),
    setCommitStatus,
  };
  const reviewer = Object.create(Reviewer.prototype) as Reviewer;
  (reviewer as any).github = github;
  return { reviewer, github, setCommitStatus };
}

describe("syncReviewCommitStatus", () => {
  it("clears a failure once every blocking thread is resolved", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "success", "All review threads resolved", "DiffSentry",
    );
  });

  it("leaves a failure standing when DiffSentry opened no threads at all", async () => {
    // A REQUEST_CHANGES can rest solely on a PR-level finding that names no
    // file. Those never become threads, so botTotal is 0 and the blocking count
    // can't see them. Clearing here would flip the PR green with nothing left to
    // resolve and no route back short of a fresh review pass.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("leaves a failure standing when only human threads are resolved", async () => {
    // Humans resolving their own threads says nothing about DiffSentry's verdict.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ total: 3, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("reds a passing status when a blocking thread is open", async () => {
    // This is the direction the old refreshReviewCommitStatus could not go,
    // which is why `ship` left the check green on a PR with 3 open threads.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 3 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "failure", "3 unresolved blocking findings", "DiffSentry",
    );
  });

  it("no-ops when the status already matches", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 1, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("leaves a failing status alone while a blocking thread is still open", async () => {
    // Already red and still should be — the sync must not rewrite an
    // unchanged status, since its return value tells `ship` whether the
    // check actually moved.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("no-ops when no DiffSentry status exists on the SHA", async () => {
    // Covers reviews.commit_status:false without a config read, and keeps the
    // sync from inventing a status for a SHA no review pass has touched.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: null,
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("no-ops when the head SHA cannot be read", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({ currentState: "failure", threads: threads() });
    (reviewer as any).github.getHeadSha = vi.fn().mockResolvedValue(null);
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("leaves nitpick-only threads green", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 4, botUnresolved: 4, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("reuses a caller-supplied head SHA and thread summary", async () => {
    // autoResolveOnPush passes headSha; the ship command passes both. Skipping
    // the redundant lookups also means the caller's SHA is the one acted on,
    // not whatever the head happens to be by the time this runs.
    const { reviewer, github, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    const suppliedThreads = threads({ botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 });

    const changed = await reviewer.syncReviewCommitStatus(1, "o", "r", 7, {
      headSha: "deadbee",
      threads: suppliedThreads,
    });

    expect(changed).toBe(true);
    expect(github.getHeadSha).not.toHaveBeenCalled();
    expect(github.summarizeReviewThreads).not.toHaveBeenCalled();
    expect(github.getCommitStatusState).toHaveBeenCalledWith(1, "o", "r", "deadbee", "DiffSentry");
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "deadbee", "success", "All review threads resolved", "DiffSentry",
    );
  });

  it("swallows a setCommitStatus failure rather than throwing", async () => {
    // Best-effort: autoResolveOnPush and the webhook path both call this
    // fire-and-forget, so a GitHub outage here must never break the caller.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    setCommitStatus.mockRejectedValue(new Error("403"));

    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
  });

  it("swallows a summarizeReviewThreads failure rather than throwing", async () => {
    const { reviewer, github, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads(),
    });
    github.summarizeReviewThreads.mockRejectedValue(new Error("503"));

    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(false);
    expect(setCommitStatus).not.toHaveBeenCalled();
  });
});
