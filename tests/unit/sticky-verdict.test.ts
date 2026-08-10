import { describe, expect, it } from "vitest";
import { resolveDisplayVerdict } from "../../src/ship-check.js";
import { renderStickyStatus } from "../../src/sticky-status.js";
import type { ReviewThreadSummary } from "../../src/github.js";

function threads(over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary {
  return { total: 0, unresolved: 0, botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0, ...over };
}

/**
 * The reported bug: a 🟢 Approved card sitting directly above its own
 * "Unresolved threads: 2" row. The pass's verdict covers the diff it just read;
 * the card speaks for the whole PR.
 */
describe("sticky card verdict", () => {
  it("refuses to approve while any thread is unresolved", () => {
    const v = resolveDisplayVerdict({
      approval: "APPROVE",
      threads: threads({ total: 2, unresolved: 2, botTotal: 2, botUnresolved: 2 }),
    });
    expect(v.state).toBe("COMMENT");
    expect(v.reason).toBe("2 unresolved threads still open");
  });

  it("reds the card when a blocking finding is open, whatever the pass said", () => {
    for (const approval of ["APPROVE", "COMMENT"] as const) {
      const v = resolveDisplayVerdict({
        approval,
        threads: threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
      });
      expect(v.state).toBe("REQUEST_CHANGES");
      expect(v.reason).toBe("1 unresolved blocking finding still open");
    }
  });

  it("holds off green for a human's open thread too", () => {
    // Not ours, so it gates nothing on the merge side — but it is still an open
    // question about the diff, and the card claims to describe the PR.
    const v = resolveDisplayVerdict({
      approval: "APPROVE",
      threads: threads({ total: 3, unresolved: 1, botTotal: 0 }),
    });
    expect(v.state).toBe("COMMENT");
  });

  it("approves a clean PR", () => {
    const v = resolveDisplayVerdict({ approval: "APPROVE", threads: threads({ total: 4, botTotal: 4 }) });
    expect(v).toEqual({ state: "APPROVE", reason: undefined });
  });

  it("keeps REQUEST_CHANGES red with no threads at all", () => {
    // A PR-level finding names no file, so it never becomes a thread.
    const v = resolveDisplayVerdict({ approval: "REQUEST_CHANGES", threads: threads() });
    expect(v).toEqual({ state: "REQUEST_CHANGES", reason: undefined });
  });

  it("adds no note when the pass reached the same verdict on its own", () => {
    const v = resolveDisplayVerdict({
      approval: "COMMENT",
      threads: threads({ total: 2, unresolved: 2, botTotal: 2, botUnresolved: 2 }),
    });
    expect(v).toEqual({ state: "COMMENT", reason: undefined });
  });

  it("falls back to PENDING with no verdict in hand", () => {
    expect(resolveDisplayVerdict({ threads: threads() }).state).toBe("PENDING");
  });

  it("under thread_gate: off, blocking threads still hold the card off green", () => {
    // The setting is about the commit status. It does not make an open critical
    // disappear, so the card drops to amber rather than to red.
    const v = resolveDisplayVerdict({
      approval: "APPROVE",
      gate: "off",
      threads: threads({ total: 1, unresolved: 1, botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    expect(v.state).toBe("COMMENT");
  });
});

describe("sticky card rendering", () => {
  const base = {
    unresolvedThreads: 2,
    failingChecks: 0,
    pendingChecks: 1,
    filesProcessed: 2,
    filesSkipped: 33,
    lastReviewedAt: "2026-08-10 05:30Z",
    lastReviewedSha: "b44c70d0000000000000000000000000000000ff",
    owner: "acme",
    repo: "app",
    botName: "diffsentry",
  };

  it("shows the downgraded verdict and why", () => {
    const body = renderStickyStatus({
      ...base,
      reviewState: "COMMENT",
      verdictReason: "2 unresolved threads still open",
    });
    expect(body).toContain("🟡 **Comments only**");
    expect(body).not.toContain("Approved");
    expect(body).toContain("2 unresolved threads still open");
  });

  it("says nothing extra when the verdict needs no explaining", () => {
    const body = renderStickyStatus({ ...base, unresolvedThreads: 0, reviewState: "APPROVE" });
    expect(body).toContain("🟢 **Approved**");
    expect(body).not.toContain("open threads, not just the latest pass");
  });
});
