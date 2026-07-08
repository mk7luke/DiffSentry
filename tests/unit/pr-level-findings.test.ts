import { describe, it, expect } from "vitest";
import { parseReviewResponse } from "../../src/ai/parse.js";
import { formatReviewBody, reconcileApproval } from "../../src/review-body.js";
import type { PRContext, ReviewComment, ReviewResult } from "../../src/types.js";

// Right-side lines: 1 (context), 2 (+), 3 (+), 4 (context), 5 (context).
// valid = {1,2,3,4,5}, changed (+) = [2,3].
const PATCH = [
  "@@ -1,3 +1,5 @@",
  " context line one",
  "+added line two",
  "+added line three",
  " context line four",
  " context line five",
].join("\n");

function ctx(): PRContext {
  return {
    owner: "o",
    repo: "r",
    pullNumber: 1,
    title: "t",
    description: "",
    baseBranch: "main",
    headBranch: "feat",
    headSha: "deadbee",
    files: [
      { filename: "src/a.ts", status: "modified", patch: PATCH, additions: 2, deletions: 0 },
    ],
  };
}

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

function prLevelComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "",
    line: 0,
    side: "RIGHT",
    body: "the report and review paths are swapped versus the backend URLs",
    type: "issue",
    severity: "major",
    title: "Route mapping swaps report and review paths.",
    prLevel: true,
    ...over,
  };
}

describe("parse: PR-level findings channel", () => {
  it("parses prLevelComments into unanchored (line 0) prLevel findings", () => {
    const raw = JSON.stringify({
      summary: "One production-breaking issue.",
      approval: "REQUEST_CHANGES",
      comments: [],
      prLevelComments: [
        {
          title: "Route mapping swaps report and review paths.",
          body: "The new route map swaps the report and review paths versus the backend-generated URLs.",
          type: "issue",
          severity: "major",
          aiAgentPrompt: "In the public routes, swap the report/review path mapping back.",
        },
      ],
    });
    const res = parseReviewResponse(raw, ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].prLevel).toBe(true);
    expect(res.comments[0].line).toBe(0);
    expect(res.comments[0].title).toBe("Route mapping swaps report and review paths.");
    // A prLevel finding is never posted inline (submitReview filters line > 0).
    expect(res.comments[0].line).not.toBeGreaterThan(0);
  });

  it("ignores prLevelComments entries missing a title or body", () => {
    const raw = JSON.stringify({
      summary: "",
      approval: "COMMENT",
      comments: [],
      prLevelComments: [
        { body: "no title" },
        { title: "no body." },
        { title: "Good one.", body: "has both" },
      ],
    });
    const res = parseReviewResponse(raw, ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].title).toBe("Good one.");
  });
});

describe("parse: un-anchorable finding demotion", () => {
  function inlineJson(severity: string, line: number): string {
    return JSON.stringify({
      summary: "",
      approval: "REQUEST_CHANGES",
      comments: [
        {
          path: "src/a.ts",
          line,
          title: "Finding far from the diff.",
          body: "body",
          type: "issue",
          severity,
          aiAgentPrompt: "fix it",
        },
      ],
    });
  }

  it("demotes an un-anchorable major finding to PR-level instead of dropping it", () => {
    // line 900 is > MAX_REMAP_DISTANCE (25) from the nearest changed line (3).
    const res = parseReviewResponse(inlineJson("major", 900), ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].prLevel).toBe(true);
    expect(res.comments[0].line).toBe(0);
  });

  it("demotes an un-anchorable critical finding to PR-level", () => {
    const res = parseReviewResponse(inlineJson("critical", 900), ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].prLevel).toBe(true);
  });

  it("still drops an un-anchorable minor finding (not worth the noise)", () => {
    const res = parseReviewResponse(inlineJson("minor", 900), ctx());
    expect(res.comments).toHaveLength(0);
  });

  it("does not demote when the finding anchors normally", () => {
    const res = parseReviewResponse(inlineJson("major", 3), ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].prLevel).toBeUndefined();
    expect(res.comments[0].line).toBe(3);
  });
});

describe("review-body: PR-level rendering", () => {
  function result(over: Partial<ReviewResult> = {}): ReviewResult {
    return { summary: "One production-breaking issue.", comments: [], approval: "COMMENT", ...over };
  }

  it("renders a dedicated section and counts prLevel findings as actionable", () => {
    const body = formatReviewBody(result({ comments: [prLevelComment()], approval: "REQUEST_CHANGES" }), META);
    expect(body).toContain("Issues not tied to a specific line (1)");
    // renderPrLevelSection emits each finding's body verbatim.
    expect(body).toContain("the report and review paths are swapped versus the backend URLs");
    // The count is no longer 0 when the only finding is PR-level — the exact
    // regression this fixes.
    expect(body).toContain("**Actionable comments posted: 1**");
    // PR-level findings must not leak a malformed entry (no path/line) into the
    // bulk agent-prompt block.
    expect(body).not.toContain("Line 0:");
    expect(body).not.toContain("In ``:");
  });

  it("combines inline + PR-level actionable findings in the count", () => {
    const inline: ReviewComment = {
      path: "src/a.ts",
      line: 3,
      side: "RIGHT",
      body: "inline issue",
      type: "issue",
      severity: "major",
      title: "Inline problem.",
    };
    const body = formatReviewBody(result({ comments: [inline, prLevelComment()] }), META);
    expect(body).toContain("**Actionable comments posted: 2**");
  });

  it("does not render the PR-level section when there are none", () => {
    const body = formatReviewBody(result(), META);
    expect(body).not.toContain("Issues not tied to a specific line");
    expect(body).toContain("**Actionable comments posted: 0**");
  });
});

describe("reconcileApproval invariant", () => {
  const issue: ReviewComment = {
    path: "src/a.ts", line: 3, side: "RIGHT", body: "x", type: "issue", severity: "major", title: "T.",
  };
  const nitpick: ReviewComment = {
    path: "src/a.ts", line: 3, side: "RIGHT", body: "x", type: "nitpick", severity: "minor", title: "N.",
  };

  it("downgrades REQUEST_CHANGES to COMMENT when no finding survives", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [])).toBe("COMMENT");
  });

  it("downgrades REQUEST_CHANGES when only nitpicks remain", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [nitpick])).toBe("COMMENT");
  });

  it("keeps REQUEST_CHANGES when an inline actionable finding backs it", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [issue])).toBe("REQUEST_CHANGES");
  });

  it("keeps REQUEST_CHANGES when a PR-level actionable finding backs it", () => {
    expect(reconcileApproval("REQUEST_CHANGES", [prLevelComment()])).toBe("REQUEST_CHANGES");
  });

  it("never touches APPROVE or COMMENT", () => {
    expect(reconcileApproval("APPROVE", [])).toBe("APPROVE");
    expect(reconcileApproval("COMMENT", [])).toBe("COMMENT");
  });
});
