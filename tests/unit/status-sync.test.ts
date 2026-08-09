import { describe, it, expect, vi } from "vitest";
import { Reviewer } from "../../src/reviewer.js";
import type { ReviewThreadSummary } from "../../src/github.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/** A Reviewer with only the GitHub calls syncReviewCommitStatus touches. */
function reviewerWith(opts: { currentState: string | null; threads: ReviewThreadSummary }) {
  const setCommitStatus = vi.fn().mockResolvedValue(undefined);
  const reviewer = Object.create(Reviewer.prototype) as Reviewer;
  (reviewer as any).github = {
    getHeadSha: vi.fn().mockResolvedValue("abc123"),
    getCommitStatusState: vi.fn().mockResolvedValue(opts.currentState),
    summarizeReviewThreads: vi.fn().mockResolvedValue(opts.threads),
    setCommitStatus,
  };
  return { reviewer, setCommitStatus };
}

describe("syncReviewCommitStatus", () => {
  it("clears a failure once every blocking thread is resolved", async () => {
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(1, "o", "r", "abc123", "success", expect.any(String), "DiffSentry");
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
});
