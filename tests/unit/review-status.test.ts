import { describe, it, expect, vi } from "vitest";
import { resolveReviewStatus } from "../../src/ship-check.js";
import type { ReviewThreadSummary } from "../../src/github.js";

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
