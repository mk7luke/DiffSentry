import { describe, it, expect } from "vitest";
import { assessChecks, isDiffSentryCheck, type CheckRunLike, type CommitStatusLike } from "../../src/checks-state.js";

const run = (name: string, conclusion: string | null): CheckRunLike => ({ name, status: "completed", conclusion });
const running = (name: string): CheckRunLike => ({ name, status: "in_progress", conclusion: null });
const status = (context: string, state: string): CommitStatusLike => ({ context, state });

const none = { statuses: [] as CommitStatusLike[], checkRuns: [] as CheckRunLike[] };

describe("isDiffSentryCheck", () => {
  it("recognises the review verdict and its sub-checks", () => {
    expect(isDiffSentryCheck("DiffSentry")).toBe(true);
    expect(isDiffSentryCheck("DiffSentry / Pre-Merge")).toBe(true);
  });

  it("leaves a repo's own similarly named job alone", () => {
    // Prefix matching on the bare name would swallow this one, and a repo that
    // tests its DiffSentry integration would silently lose a real check.
    expect(isDiffSentryCheck("DiffSentry integration tests")).toBe(false);
    expect(isDiffSentryCheck("build")).toBe(false);
  });
});

describe("assessChecks", () => {
  it("passes when every check run and status is green", () => {
    const verdict = assessChecks({
      checkRuns: [run("build", "success"), run("test", "success")],
      statuses: [status("ci/jenkins", "success")],
    });
    expect(verdict.state).toBe("passed");
    expect(verdict.counted).toBe(3);
  });

  it("merges the two systems rather than trusting either alone", () => {
    // The whole reason both lists are fetched: a green Actions run says nothing
    // about the legacy status a deploy bot is still writing.
    expect(
      assessChecks({ checkRuns: [run("build", "success")], statuses: [status("ci/jenkins", "pending")] }).state,
    ).toBe("pending");
    expect(
      assessChecks({ checkRuns: [running("build")], statuses: [status("ci/jenkins", "success")] }).state,
    ).toBe("pending");
  });

  it("holds while a check run has not completed", () => {
    const verdict = assessChecks({ checkRuns: [run("build", "success"), running("e2e")], statuses: [] });
    expect(verdict.state).toBe("pending");
    expect(verdict.pending).toEqual(["e2e"]);
  });

  it("counts neutral and skipped as passes", () => {
    expect(assessChecks({ checkRuns: [run("format", "neutral"), run("deploy", "skipped")], statuses: [] }).state)
      .toBe("passed");
  });

  it("counts cancelled, timed out and action_required as failures", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "failure"]) {
      expect(assessChecks({ checkRuns: [run("build", conclusion)], statuses: [] }).state).toBe("failed");
    }
  });

  it("treats a completed run with no conclusion as a failure", () => {
    // Fail-safe: an unreadable result withholds the notes rather than passing.
    expect(assessChecks({ checkRuns: [run("build", null)], statuses: [] }).state).toBe("failed");
  });

  it("reports failed rather than pending when both are present", () => {
    const verdict = assessChecks({ checkRuns: [run("build", "failure"), running("e2e")], statuses: [] });
    expect(verdict.state).toBe("failed");
    expect(verdict.failed).toEqual(["build"]);
  });

  it("treats a failing or erroring commit status as a failure", () => {
    expect(assessChecks({ checkRuns: [], statuses: [status("ci/jenkins", "failure")] }).state).toBe("failed");
    expect(assessChecks({ checkRuns: [], statuses: [status("ci/jenkins", "error")] }).state).toBe("failed");
  });

  it("reports none when the PR has no checks at all", () => {
    // Not a pass. A repo with no CI has vacuously passed everything, and firing
    // on that would post on every PR in it.
    expect(assessChecks(none).state).toBe("none");
  });

  it("reports none when DiffSentry's own checks are the only ones present", () => {
    const verdict = assessChecks({
      checkRuns: [],
      statuses: [status("DiffSentry", "success"), status("DiffSentry / Pre-Merge", "success")],
    });
    expect(verdict.state).toBe("none");
    expect(verdict.counted).toBe(0);
  });

  it("passes with real checks green even while DiffSentry's own check is red", () => {
    // The deadlock this exclusion exists to avoid: since the thread gate landed,
    // an open critical finding pins `DiffSentry` to failure, and counting it
    // would mean release notes never arrive on a PR with open findings.
    const verdict = assessChecks({
      checkRuns: [run("build", "success")],
      statuses: [status("DiffSentry", "failure"), status("DiffSentry / Pre-Merge", "failure")],
    });
    expect(verdict.state).toBe("passed");
    expect(verdict.counted).toBe(1);
    expect(verdict.failed).toEqual([]);
  });
});
