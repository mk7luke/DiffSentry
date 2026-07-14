import { describe, it, expect, vi } from "vitest";
import { formatReviewBody, reconcileApproval, isVisiblyActionable } from "../../src/review-body.js";
import { titleSimilarity, isRepeatPrLevelFinding, prLevelRepeatKey } from "../../src/ai/parse.js";
import { detectDescriptionDrift, applyDriftToApproval, type DriftFinding } from "../../src/drift.js";
import { GitHubClient } from "../../src/github.js";
import type { Config, PRContext, ReviewComment, ReviewResult } from "../../src/types.js";

// Companion to pr-level-findings.test.ts (which covers PR #76's "a block must
// name a finding" invariant). This file covers the noise controls layered on
// top: PR-level findings only claim the unresolvable review body when they're
// high-confidence and file-scoped ones become real threads instead.

const META = {
  profile: "chill",
  owner: "o",
  repo: "r",
  headSha: "deadbee",
  baseBranch: "main",
  headBranch: "feat",
  filesProcessed: ["src/a.ts"],
  botName: "diffsentry",
};

function result(over: Partial<ReviewResult> = {}): ReviewResult {
  return { summary: "s", comments: [], approval: "COMMENT", ...over };
}

/** Body-level: no path — nowhere to hang a thread (drift, whole-PR concerns). */
function bodyFinding(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "",
    line: 0,
    side: "RIGHT",
    body: "the description claims a default change the diff never makes",
    type: "issue",
    severity: "major",
    title: "tk02 does not change the DB status column default to not_started",
    prLevel: true,
    ...over,
  };
}

/** File-level: path survived, line didn't — postable as a file-scoped thread. */
function fileFinding(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/a.ts",
    line: 0,
    side: "RIGHT",
    body: "edit-mode fields were removed from the lead detail view",
    type: "issue",
    severity: "major",
    title: "Lead detail removes editable Qualification Long Form",
    prLevel: true,
    ...over,
  };
}

describe("review-body: confidence gates the unresolvable section", () => {
  it("gives a high-confidence body finding the prominent section and counts it", () => {
    const body = formatReviewBody(result({ comments: [bodyFinding({ confidence: "high" })] }), META);
    expect(body).toContain("Issues not tied to a specific line (1)");
    expect(body).toContain("**Actionable comments posted: 1**");
    expect(body).not.toContain("Lower-confidence observations");
  });

  it("collapses a medium-confidence body finding and drops it from the count", () => {
    // The exact shape of the noise being fixed: a Major/Medium drift finding
    // that claimed a top-of-review slot on every single review.
    const body = formatReviewBody(result({ comments: [bodyFinding({ confidence: "medium" })] }), META);
    expect(body).toContain("Lower-confidence observations about the change as a whole (1)");
    expect(body).not.toContain("Issues not tied to a specific line");
    expect(body).toContain("**Actionable comments posted: 0**");
    // Still present — collapsed, not deleted.
    expect(body).toContain("the description claims a default change the diff never makes");
  });

  it("collapses a low-confidence body finding too", () => {
    const body = formatReviewBody(result({ comments: [bodyFinding({ confidence: "low" })] }), META);
    expect(body).toContain("Lower-confidence observations about the change as a whole (1)");
    expect(body).toContain("**Actionable comments posted: 0**");
  });

  it("treats an absent confidence as high, matching the renderer's documented default", () => {
    const body = formatReviewBody(result({ comments: [bodyFinding({ confidence: undefined })] }), META);
    expect(body).toContain("Issues not tied to a specific line (1)");
  });

  it("splits a mixed set across both sections", () => {
    const body = formatReviewBody(
      result({
        comments: [
          bodyFinding({ confidence: "high", title: "A." }),
          bodyFinding({ confidence: "medium", title: "B." }),
          bodyFinding({ confidence: "low", title: "C." }),
        ],
      }),
      META,
    );
    expect(body).toContain("Issues not tied to a specific line (1)");
    expect(body).toContain("Lower-confidence observations about the change as a whole (2)");
    expect(body).toContain("**Actionable comments posted: 1**");
  });
});

describe("review-body: file-level findings are threads, not body prose", () => {
  it("counts a file-level finding without printing it in the body", () => {
    const body = formatReviewBody(result({ comments: [fileFinding()] }), META);
    // It's posted as its own review thread by submitReview — printing it here
    // too would say everything twice.
    expect(body).not.toContain("edit-mode fields were removed");
    expect(body).not.toContain("Issues not tied to a specific line");
    expect(body).toContain("**Actionable comments posted: 1**");
  });

  it("counts a medium-confidence file-level finding — a thread can be resolved", () => {
    // Confidence only gates the body section. A thread carries no permanent
    // cost, so it doesn't need to clear the same bar.
    const body = formatReviewBody(result({ comments: [fileFinding({ confidence: "medium" })] }), META);
    expect(body).toContain("**Actionable comments posted: 1**");
  });

  it("never routes a file-level finding into the bulk agent prompt", () => {
    const body = formatReviewBody(
      result({ comments: [fileFinding({ aiAgentPrompt: "fix the lead detail" })] }),
      META,
    );
    expect(body).not.toContain("Line 0:");
  });
});

describe("isVisiblyActionable", () => {
  it("rejects nitpicks regardless of channel or confidence", () => {
    expect(isVisiblyActionable(bodyFinding({ severity: "minor", confidence: "high" }))).toBe(false);
    expect(isVisiblyActionable(fileFinding({ type: "nitpick" }))).toBe(false);
  });

  it("accepts an inline actionable finding", () => {
    const inline: ReviewComment = {
      path: "src/a.ts", line: 3, side: "RIGHT", body: "x", type: "issue", severity: "major", title: "T.",
    };
    expect(isVisiblyActionable(inline)).toBe(true);
  });
});

describe("reconcileApproval with confidence-gated findings", () => {
  it("downgrades a block backed only by a medium-confidence body finding", () => {
    // Otherwise we'd re-introduce exactly what #76 fixed: "changes requested"
    // with nothing prominent to act on, the finding buried in a collapse.
    expect(reconcileApproval("REQUEST_CHANGES", [bodyFinding({ confidence: "medium" })])).toBe("COMMENT");
  });

  it("keeps a block backed by a high-confidence body finding", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [bodyFinding({ confidence: "high" })])).toBe("REQUEST_CHANGES");
  });

  it("keeps a block backed by a file-level finding at any confidence", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [fileFinding({ confidence: "low" })])).toBe("REQUEST_CHANGES");
  });
});

describe("applyDriftToApproval: only drift we stand behind costs an approval", () => {
  function drift(confidence: DriftFinding["confidence"]): DriftFinding {
    return { level: "warning", summary: "s", details: "d", confidence };
  }

  it("keeps APPROVE when the only drift is medium-confidence", () => {
    // The headline promise: a hedged diff-vs-description reading must not
    // quietly turn a clean PR into a commented one.
    expect(applyDriftToApproval("APPROVE", [drift("medium")])).toBe("APPROVE");
  });

  it("keeps APPROVE when the only drift is low-confidence", () => {
    expect(applyDriftToApproval("APPROVE", [drift("low")])).toBe("APPROVE");
  });

  it("downgrades APPROVE to COMMENT for high-confidence drift", () => {
    expect(applyDriftToApproval("APPROVE", [drift("high")])).toBe("COMMENT");
  });

  it("downgrades when any drift in a mixed set is high-confidence", () => {
    expect(applyDriftToApproval("APPROVE", [drift("medium"), drift("high")])).toBe("COMMENT");
  });

  it("never escalates a block or relaxes one", () => {
    expect(applyDriftToApproval("REQUEST_CHANGES", [drift("high")])).toBe("REQUEST_CHANGES");
    expect(applyDriftToApproval("COMMENT", [drift("high")])).toBe("COMMENT");
    expect(applyDriftToApproval("APPROVE", [])).toBe("APPROVE");
  });

  it("cannot be turned into a downgrade by reconcileApproval afterwards", () => {
    // reconcileApproval is the only other thing that touches the verdict, and it
    // guards on REQUEST_CHANGES — so the APPROVE + medium-drift path stays
    // APPROVE end to end, through both rules in the order reviewer.ts runs them.
    const approval = applyDriftToApproval("APPROVE", [drift("medium")]);
    expect(reconcileApproval(approval, [bodyFinding({ confidence: "medium" })])).toBe("APPROVE");
  });
});

describe("titleSimilarity / isRepeatPrLevelFinding", () => {
  it("scores a re-worded restatement of one finding above the repeat threshold", () => {
    const a = "Lead detail removes editable Qualification Long Form fields";
    const b = "Lead detail removes the editable Qualification Long Form accordion fields";
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it("scores two genuinely distinct findings well below it", () => {
    const a = "Lead detail removes editable Qualification Long Form";
    const b = "tk02 never widens the status column server_default";
    expect(titleSimilarity(a, b)).toBeLessThan(0.6);
  });

  it("is 0 against an empty or stopword-only title", () => {
    expect(titleSimilarity("", "anything at all here")).toBe(0);
    expect(titleSimilarity("it is the that", "a real finding about routing")).toBe(0);
  });

  it("suppresses a re-worded repeat of a prior PR-level finding", () => {
    const prior = [prLevelRepeatKey("", "Lead detail removes editable Qualification Long Form fields")];
    const candidate = { path: "", title: "Lead detail removes the editable Qualification Long Form accordion fields" };
    expect(isRepeatPrLevelFinding(candidate, prior)).toBe(true);
  });

  it("does not suppress a same-sounding finding scoped to a different file", () => {
    const prior = [prLevelRepeatKey("src/a.ts", "Lead detail removes editable Qualification Long Form fields")];
    const candidate = { path: "src/b.ts", title: "Lead detail removes editable Qualification Long Form fields" };
    expect(isRepeatPrLevelFinding(candidate, prior)).toBe(false);
  });

  it("does not suppress a distinct finding", () => {
    const prior = [prLevelRepeatKey("", "Lead detail removes editable Qualification Long Form")];
    const candidate = { path: "", title: "tk02 never widens the status column server_default" };
    expect(isRepeatPrLevelFinding(candidate, prior)).toBe(false);
  });

  it("suppresses nothing when there is no prior state or no title", () => {
    expect(isRepeatPrLevelFinding({ path: "", title: "anything" }, [])).toBe(false);
    expect(isRepeatPrLevelFinding({ path: "", title: undefined }, [prLevelRepeatKey("", "anything")])).toBe(false);
  });

  it("covers FILE-level findings, not just body-level ones", () => {
    // Guards the property that keeps re-worded file findings from stacking
    // duplicate threads in the Files tab on every push: the reviewer's
    // similarity pass filters on `c.prLevel`, which spans both flavours, and
    // records keys with each finding's real path. A path-scoped repeat must
    // collapse against its path-scoped prior exactly like an unscoped one does.
    const prior = [prLevelRepeatKey("src/22-leads.js", "Lead detail removes editable Qualification Long Form fields")];
    const reworded = {
      path: "src/22-leads.js",
      title: "Lead detail removes the editable Qualification Long Form accordion fields",
    };
    expect(isRepeatPrLevelFinding(reworded, prior)).toBe(true);
  });

  it("keeps file-level and body-level findings in separate identity scopes", () => {
    // Drift is always emitted unscoped (path: ""), so an unscoped candidate must
    // not collapse against a same-titled file-scoped prior — they are claims
    // about different things and each deserves its own thread/section.
    const fileScopedPrior = [prLevelRepeatKey("src/a.ts", "Lead detail removes editable Qualification Long Form")];
    expect(
      isRepeatPrLevelFinding({ path: "", title: "Lead detail removes editable Qualification Long Form" }, fileScopedPrior),
    ).toBe(false);
  });
});

describe("drift: confidence is carried, not assumed", () => {
  function ctx(description: string): PRContext {
    return {
      owner: "o", repo: "r", pullNumber: 1, title: "t",
      description,
      baseBranch: "main", headBranch: "feat", headSha: "deadbee",
      files: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n+x", additions: 1, deletions: 0 }],
    };
  }
  const LONG_DESC = "This PR does a number of things worth describing at length.";

  function aiReturning(raw: string) {
    return { chat: vi.fn().mockResolvedValue(raw) } as any;
  }

  it("carries an explicit high confidence through", async () => {
    const ai = aiReturning(JSON.stringify([
      { level: "warning", summary: "s", details: "d", confidence: "high" },
    ]));
    const out = await detectDescriptionDrift({ ai, context: ctx(LONG_DESC) });
    expect(out[0].confidence).toBe("high");
  });

  it("defaults a missing confidence to medium, not high", async () => {
    // Drift is diagnosed by comparing prose to code and is the finding class
    // most prone to confident-sounding false positives, so silence here must
    // not buy a prominent slot.
    const ai = aiReturning(JSON.stringify([{ level: "warning", summary: "s", details: "d" }]));
    const out = await detectDescriptionDrift({ ai, context: ctx(LONG_DESC) });
    expect(out[0].confidence).toBe("medium");
  });

  it("coerces a garbage confidence to medium", async () => {
    const ai = aiReturning(JSON.stringify([
      { level: "warning", summary: "s", details: "d", confidence: "very-sure" },
    ]));
    const out = await detectDescriptionDrift({ ai, context: ctx(LONG_DESC) });
    expect(out[0].confidence).toBe("medium");
  });

  it("keeps the short-description sentinel informational", async () => {
    const ai = aiReturning("[]");
    const out = await detectDescriptionDrift({ ai, context: ctx("tiny") });
    expect(out[0].level).toBe("info");
    expect(ai.chat).not.toHaveBeenCalled();
  });
});

describe("submitReview: file-level threads and superseded reviews", () => {
  const MARKER = "<!-- This is an auto-generated comment by DiffSentry for review status -->";

  function ctx(): PRContext {
    return {
      owner: "o", repo: "r", pullNumber: 7, title: "t", description: "d",
      baseBranch: "main", headBranch: "feat", headSha: "deadbee", files: [],
    };
  }

  function fakeOctokit(over: { reviews?: any[]; createReviewComment?: any } = {}) {
    const calls = {
      createReview: vi.fn().mockResolvedValue({}),
      createReviewComment: over.createReviewComment ?? vi.fn().mockResolvedValue({}),
      dismissReview: vi.fn().mockResolvedValue({}),
      updateReview: vi.fn().mockResolvedValue({}),
      listReviews: vi.fn(),
    };
    const octokit: any = {
      pulls: calls,
      paginate: vi.fn().mockResolvedValue(over.reviews ?? []),
    };
    return { octokit, calls };
  }

  function clientWith(octokit: any): GitHubClient {
    const client = new GitHubClient({} as Config);
    client.getInstallationOctokit = vi.fn().mockResolvedValue(octokit);
    return client;
  }

  it("posts a file-level finding as a resolvable file-scoped thread", async () => {
    const { octokit, calls } = fakeOctokit();
    await clientWith(octokit).submitReview(1, ctx(), result({ comments: [fileFinding()] }));

    expect(calls.createReviewComment).toHaveBeenCalledTimes(1);
    expect(calls.createReviewComment.mock.calls[0][0]).toMatchObject({
      path: "src/a.ts",
      subject_type: "file",
      commit_id: "deadbee",
    });
    // Not duplicated into the review body.
    expect(calls.createReview.mock.calls[0][0].body).not.toContain("couldn't be attached");
  });

  it("folds a rejected file-level finding back into the review body", async () => {
    // A finding must never vanish between the thread and body channels — the
    // silent-loss failure #76 exists to prevent.
    const { octokit, calls } = fakeOctokit({
      createReviewComment: vi.fn().mockRejectedValue(Object.assign(new Error("422"), { status: 422 })),
    });
    await clientWith(octokit).submitReview(1, ctx(), result({ comments: [fileFinding()] }));

    const body = calls.createReview.mock.calls[0][0].body;
    expect(body).toContain("couldn't be attached to their file (1)");
    expect(body).toContain("edit-mode fields were removed from the lead detail view");
  });

  it("dismisses a superseded CHANGES_REQUESTED review and stubs a COMMENTED one", async () => {
    // COMMENTED reviews can't be dismissed via the API and submitted reviews
    // can't be deleted, so the body is rewritten instead. Without this, every
    // drift-driven review keeps its full text on the timeline forever.
    const { octokit, calls } = fakeOctokit({
      reviews: [
        { id: 1, state: "CHANGES_REQUESTED", body: `old block${MARKER}` },
        { id: 2, state: "COMMENTED", body: `old comment${MARKER}` },
      ],
    });
    await clientWith(octokit).submitReview(1, ctx(), result());

    expect(calls.dismissReview).toHaveBeenCalledTimes(1);
    expect(calls.dismissReview.mock.calls[0][0]).toMatchObject({ review_id: 1 });
    expect(calls.updateReview).toHaveBeenCalledTimes(1);
    expect(calls.updateReview.mock.calls[0][0]).toMatchObject({ review_id: 2 });
    expect(calls.updateReview.mock.calls[0][0].body).toContain("superseded");
  });

  it("leaves other bots' and humans' reviews alone", async () => {
    // The old filter was `user.type === "Bot"`, which reached other bots'
    // reviews. Match on our own marker instead.
    const { octokit, calls } = fakeOctokit({
      reviews: [
        { id: 1, state: "CHANGES_REQUESTED", body: "some other bot's review" },
        { id: 2, state: "COMMENTED", body: "a human's note" },
        { id: 3, state: "APPROVED", body: `ours, approved${MARKER}` },
      ],
    });
    await clientWith(octokit).submitReview(1, ctx(), result());

    expect(calls.dismissReview).not.toHaveBeenCalled();
    expect(calls.updateReview).not.toHaveBeenCalled();
  });

  it("still posts the review when retiring a stale one fails", async () => {
    const { octokit, calls } = fakeOctokit({
      reviews: [{ id: 1, state: "COMMENTED", body: `ours${MARKER}` }],
    });
    calls.updateReview.mockRejectedValue(new Error("no permission"));
    await clientWith(octokit).submitReview(1, ctx(), result());
    expect(calls.createReview).toHaveBeenCalledTimes(1);
  });
});
