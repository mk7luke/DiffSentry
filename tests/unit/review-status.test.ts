import { describe, it, expect, vi } from "vitest";
import { resolveReviewStatus } from "../../src/ship-check.js";
import { REVIEW_STATUS_CONTEXT, type ReviewThreadSummary } from "../../src/github.js";
import { Reviewer } from "../../src/reviewer.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/**
 * Mirrors the empty-diff branch at src/reviewer.ts:836 — the "Merge branch
 * 'main' into …" case that used to hard-code success and erase a real failure.
 */
describe("empty-diff status decision", () => {
  it("stays red when a blocking thread is open", () => {
    const r = resolveReviewStatus({
      threads: threads({ botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 }),
      successDescription: "No reviewable files",
    });
    expect(r).toEqual({ state: "failure", description: "2 unresolved blocking findings" });
  });

  it("goes green when nothing blocks", () => {
    const r = resolveReviewStatus({ threads: threads(), successDescription: "No reviewable files" });
    expect(r).toEqual({ state: "success", description: "No reviewable files" });
  });

  it("goes green when the only open threads are nitpicks", () => {
    const r = resolveReviewStatus({
      threads: threads({ botTotal: 2, botUnresolved: 2, botUnresolvedBlocking: 0 }),
      successDescription: "No reviewable files",
    });
    expect(r.state).toBe("success");
  });
});

describe("final-verdict status decision", () => {
  it("reds a COMMENT verdict that left a blocking thread open", () => {
    const r = resolveReviewStatus({
      approval: "COMMENT",
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      successDescription: "Review complete with comments",
    });
    expect(r.state).toBe("failure");
  });

  it("keeps APPROVE green", () => {
    const r = resolveReviewStatus({ approval: "APPROVE", threads: threads(), successDescription: "Looks good!" });
    expect(r).toEqual({ state: "success", description: "Looks good!" });
  });
});

/**
 * `Reviewer.writeReviewStatus` is the shared plumbing both call sites in
 * src/reviewer.ts (the empty-diff early-return and the final verdict) route
 * through. These drive it directly — the seam the two sites can't drift
 * back apart from — rather than the decision function alone, so a
 * regression that reintroduces a hard-coded `success` at either call site
 * would fail here.
 */
describe("Reviewer.writeReviewStatus (wiring)", () => {
  function reviewerWith(github: Record<string, unknown>) {
    // Bypass the constructor: it builds real AI providers and a GitHub
    // client, neither of which this method touches.
    const reviewer = Object.create(Reviewer.prototype) as Reviewer;
    (reviewer as unknown as { github: unknown }).github = github;
    return reviewer as unknown as {
      writeReviewStatus: (
        installationId: number,
        owner: string,
        repo: string,
        headSha: string,
        pullNumber: number,
        opts: { approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; successDescription: string },
        signal: AbortSignal | undefined,
        onStatusError: (err: unknown) => void,
      ) => Promise<void>;
    };
  }

  it("empty-diff shape (no approval): reds when a blocking thread is open", async () => {
    const setCommitStatus = vi.fn().mockResolvedValue(undefined);
    const reviewer = reviewerWith({
      summarizeReviewThreads: vi.fn().mockResolvedValue(
        threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      ),
      setCommitStatus,
    });

    await reviewer.writeReviewStatus(
      1, "o", "r", "sha1", 7, { successDescription: "No reviewable files" }, undefined, () => {},
    );

    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "sha1", "failure", "1 unresolved blocking finding", REVIEW_STATUS_CONTEXT, undefined,
    );
  });

  it("empty-diff shape: goes green when nothing blocks", async () => {
    const setCommitStatus = vi.fn().mockResolvedValue(undefined);
    const reviewer = reviewerWith({
      summarizeReviewThreads: vi.fn().mockResolvedValue(threads()),
      setCommitStatus,
    });

    await reviewer.writeReviewStatus(
      1, "o", "r", "sha1", 7, { successDescription: "No reviewable files" }, undefined, () => {},
    );

    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "sha1", "success", "No reviewable files", REVIEW_STATUS_CONTEXT, undefined,
    );
  });

  it("final-verdict shape: reds a COMMENT verdict that left a blocking thread open", async () => {
    const setCommitStatus = vi.fn().mockResolvedValue(undefined);
    const reviewer = reviewerWith({
      summarizeReviewThreads: vi.fn().mockResolvedValue(
        threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      ),
      setCommitStatus,
    });

    await reviewer.writeReviewStatus(
      1, "o", "r", "sha1", 7,
      { approval: "COMMENT", successDescription: "Review complete with comments" },
      undefined, () => {},
    );

    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "sha1", "failure", "1 unresolved blocking finding", REVIEW_STATUS_CONTEXT, undefined,
    );
  });

  it("writes nothing when the thread fetch rejects and there is no verdict", async () => {
    // The empty-diff path. An all-zero stand-in would resolve to `success` and
    // green a PR with open criticals on a network blip — the reported bug by
    // another route. With no verdict to fall back on, leave the SHA's existing
    // status alone.
    const setCommitStatus = vi.fn().mockResolvedValue(undefined);
    const reviewer = reviewerWith({
      summarizeReviewThreads: vi.fn().mockRejectedValue(new Error("boom")),
      setCommitStatus,
    });

    await reviewer.writeReviewStatus(
      1, "o", "r", "sha1", 7, { successDescription: "No reviewable files" }, undefined, () => {},
    );

    expect(setCommitStatus).not.toHaveBeenCalled();
  });

  it("writes nothing when the thread fetch rejects even with a verdict in hand", async () => {
    // Falling back to the verdict looks safe but greens the wrong case: a pass
    // that just posted blocking threads and returns COMMENT would resolve to
    // `success` off an all-zero stand-in, putting a green check beside its own
    // open criticals. Leaving the SHA alone fails closed — the `pending` written
    // on entry keeps the merge blocked until a sync converges.
    const setCommitStatus = vi.fn().mockResolvedValue(undefined);
    const reviewer = reviewerWith({
      summarizeReviewThreads: vi.fn().mockRejectedValue(new Error("boom")),
      setCommitStatus,
    });

    await reviewer.writeReviewStatus(
      1, "o", "r", "sha1", 7,
      { approval: "COMMENT", successDescription: "Review complete with comments" },
      undefined, () => {},
    );

    expect(setCommitStatus).not.toHaveBeenCalled();
  });
});
