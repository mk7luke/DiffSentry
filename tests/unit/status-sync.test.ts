import { describe, it, expect, vi } from "vitest";
import { Reviewer } from "../../src/reviewer.js";
import type { ReviewThreadSummary } from "../../src/github.js";
import { assessShipSignals, renderShipCheck } from "../../src/ship-check.js";

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
    // Every call that omits `gate` loads it from repo config, so the default
    // fixture has to serve that path — otherwise the missing method throws,
    // gets swallowed into the documented default, and the suite passes for the
    // wrong reason: a regression that stopped loading the gate would be
    // invisible to all but the one dedicated config test. Empty config ⇒ no
    // `thread_gate` key ⇒ `undefined` ⇒ the default gate, via the real path.
    getInstallationOctokit: vi.fn().mockResolvedValue({
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: { type: "file", content: "" } }),
      },
    }),
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

  it("clears a failure when the only threads left open are nitpicks", async () => {
    // The guard that keeps a PR-level-finding failure standing must key on
    // "DiffSentry opened no threads at all", not on "every thread is resolved".
    // Keying on the latter would pin the check red on an open nitpick, which
    // the documented rule says never blocks.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ total: 2, unresolved: 1, botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "success", "All review threads resolved", "DiffSentry",
    );
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

  // `ship` decides whether a failing DiffSentry check is stale via
  // assessShipSignals, then asks the sync to actually clear it. If those two
  // predicates ever disagree, `ship` reports the check as cleared while it stays
  // red (or lists it as a blocker right after greening it) — the exact
  // incoherence this whole change set out to remove. They live in two files with
  // nothing else tying them together, so pin the invariant.
  it("agrees with assessShipSignals about which failures are clearable", async () => {
    const matrix = [
      { botTotal: 0, botUnresolved: 0, botUnresolvedBlocking: 0 }, // PR-level finding only
      { botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 }, // all resolved
      { botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 0 }, // nitpick open
      { botTotal: 2, botUnresolved: 1, botUnresolvedBlocking: 1 }, // blocking open
      { botTotal: 3, botUnresolved: 3, botUnresolvedBlocking: 2 }, // mixed
    ];

    // Both gates, because they diverge differently: under `off` the sync ignores
    // blocking threads and clears, so triage must too.
    for (const gate of ["blocking", "off"] as const) {
      for (const over of matrix) {
        const t = threads({ total: over.botTotal, unresolved: over.botUnresolved, ...over });
        const failing = { context: "DiffSentry", state: "failure" };

        const shipSaysStale =
          assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [failing], gate }).staleFailing.length > 0;

        const { reviewer } = reviewerWith({ currentState: "failure", threads: t });
        const syncCleared = await reviewer.syncReviewCommitStatus(1, "o", "r", 7, { gate });

        expect({ gate, ...over, stale: shipSaysStale }).toEqual({ gate, ...over, stale: syncCleared });

        // The other direction: from green, the sync must red exactly when ship
        // would call the threads blocking. Covering only the clearing direction
        // would let the two drift apart on reding and nothing would notice.
        const shipSaysBlocked =
          renderShipCheck({
            botName: "diffsentry", reviewState: "COMMENTED", threads: t,
            signals: assessShipSignals({ reviewState: "COMMENTED", threads: t, statuses: [], gate }),
            statusRefreshed: false, gate,
          }).includes("unresolved blocking finding");

        const { reviewer: r2, setCommitStatus: wrote } = reviewerWith({ currentState: "success", threads: t });
        await r2.syncReviewCommitStatus(1, "o", "r", 7, { gate });
        const syncRedded = wrote.mock.calls.some((c: unknown[]) => c[4] === "failure");

        expect({ gate, ...over, blocked: shipSaysBlocked }).toEqual({ gate, ...over, blocked: syncRedded });
      }
    }
  });

  it("normalises an invalid thread_gate value to the default gate", async () => {
    // loadRepoConfig does no schema validation, and resolveReviewStatus asks
    // `=== "blocking"` while triage/render ask `=== "off"`. A raw `blockign`
    // would disable the gate here while leaving it on everywhere else — so the
    // sync path has to normalise, not just `ship`.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "success",
      threads: threads({ botTotal: 1, botUnresolved: 1, botUnresolvedBlocking: 1 }),
    });
    (reviewer as any).github.getInstallationOctokit = vi.fn().mockResolvedValue({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("reviews:\n  thread_gate: blockign\n", "utf-8").toString("base64"),
          },
        }),
      },
    });

    // Garbage must not read as "off" — the blocking thread still reds the check.
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "failure", "1 unresolved blocking finding", "DiffSentry",
    );
  });

  it("treats an existing error state like a failure", async () => {
    // getCommitStatusState returns whatever GitHub has, and `error` is a legal
    // state DiffSentry itself never writes but a re-run or an external tool can
    // leave behind. It must not read as "already matching" and strand the check.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "error",
      threads: threads({ botTotal: 2, botUnresolved: 0, botUnresolvedBlocking: 0 }),
    });
    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "success", "All review threads resolved", "DiffSentry",
    );
  });

  it("honours reviews.thread_gate from repo config when the caller supplies none", async () => {
    // The webhook can't pass a gate — its interface has no opts parameter — so
    // the sync must load it. Without this, `thread_gate: off` is silently
    // ignored on the most frequent trigger.
    // Fixture chosen so the two gates diverge on the *write*, not on a shared
    // no-op: current `failure` with blocking threads open clears under `off`
    // and stays put under `blocking`. A swallowed config load would fall back
    // to `blocking` and fail this, so a pass can't be faked by the fallback.
    const { reviewer, setCommitStatus } = reviewerWith({
      currentState: "failure",
      threads: threads({ botTotal: 2, botUnresolved: 2, botUnresolvedBlocking: 2 }),
    });
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("reviews:\n  thread_gate: off\n", "utf-8").toString("base64"),
          },
        }),
      },
    });
    (reviewer as any).github.getInstallationOctokit = getInstallationOctokit;

    await expect(reviewer.syncReviewCommitStatus(1, "o", "r", 7)).resolves.toBe(true);
    expect(getInstallationOctokit).toHaveBeenCalledWith(1);
    expect(setCommitStatus).toHaveBeenCalledWith(
      1, "o", "r", "abc123", "success", "All review threads resolved", "DiffSentry",
    );
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
