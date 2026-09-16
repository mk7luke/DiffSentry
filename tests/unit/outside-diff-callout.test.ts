import { describe, it, expect } from "vitest";
import { parseReviewResponse } from "../../src/ai/parse.js";
import { formatReviewBody, isOutsideDiffFinding } from "../../src/review-body.js";
import type { PRContext, ReviewComment, ReviewResult } from "../../src/types.js";

// Right-side lines 1..5; only 2 and 3 are added. Anything past line 30 is
// beyond MAX_REMAP_DISTANCE and so cannot be anchored at all.
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
    files: [{ filename: "src/a.ts", status: "modified", patch: PATCH, additions: 2, deletions: 0 }],
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

function parse(raw: object) {
  return parseReviewResponse(JSON.stringify(raw), ctx());
}

describe("tracking which findings fell outside the diff", () => {
  it("tags a blocking finding whose line is too far from the diff to anchor", () => {
    const res = parse({
      summary: "s",
      approval: "COMMENT",
      comments: [
        {
          path: "src/a.ts",
          line: 501,
          title: "Close the remote snapshot when local persistence fails.",
          body: "Prose.",
          severity: "major",
        },
      ],
    });
    const outside = res.comments.filter(isOutsideDiffFinding);
    expect(outside).toHaveLength(1);
    // The reason is preserved, not just the fact: the model named line 501 and
    // GitHub had nowhere on the diff to host it.
    expect(outside[0].outsideDiff).toEqual({ claimedLine: 501 });
    expect(outside[0].line).toBe(0);
    expect(outside[0].prLevel).toBe(true);
  });

  it("tags a blocking finding that named a file but no line", () => {
    const res = parse({
      summary: "s",
      approval: "COMMENT",
      comments: [
        { path: "src/a.ts", title: "A blocker.", body: "Prose.", severity: "critical" },
      ],
    });
    const outside = res.comments.filter(isOutsideDiffFinding);
    expect(outside).toHaveLength(1);
    expect(outside[0].outsideDiff).toEqual({ claimedLine: null });
  });

  // A prLevelComments entry with a path is file-scoped because the MODEL chose
  // to scope it there. Calling that "outside the diff" would be a lie about why
  // it has no line.
  it("does not tag a PR-level finding the model itself scoped to a file", () => {
    const res = parse({
      summary: "s",
      approval: "COMMENT",
      comments: [],
      prLevelComments: [
        { path: "src/a.ts", title: "The README contradicts the change.", body: "Prose.", severity: "major" },
      ],
    });
    expect(res.comments.filter(isOutsideDiffFinding)).toHaveLength(0);
    expect(res.comments[0].prLevel).toBe(true);
    expect(res.comments[0].path).toBe("src/a.ts");
  });

  it("does not tag an anchorable finding", () => {
    const res = parse({
      summary: "s",
      approval: "COMMENT",
      comments: [{ path: "src/a.ts", line: 2, title: "T.", body: "Prose.", severity: "major" }],
    });
    expect(res.comments.filter(isOutsideDiffFinding)).toHaveLength(0);
  });
});

function outsideComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/a.ts",
    line: 0,
    side: "RIGHT",
    body: "_🟠 Major_\n\n**A finding.**\n\nProse.",
    title: "A finding.",
    severity: "major",
    prLevel: true,
    outsideDiff: { claimedLine: 501 },
    ...over,
  };
}

function result(comments: ReviewComment[]): ReviewResult {
  return { summary: "s", comments, approval: "COMMENT" };
}

describe("the outside-diff callout", () => {
  it("reads severity, title and location without opening anything", () => {
    const body = formatReviewBody(
      result([
        outsideComment({ title: "Close the remote snapshot.", severity: "major", outsideDiff: { claimedLine: 725 } }),
        outsideComment({ title: "Delete the uploaded object.", severity: "critical", outsideDiff: { claimedLine: 1501 } }),
      ]),
      META,
    );

    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain(
      "> Some comments are outside the diff and can't be posted inline due to GitHub limitations.",
    );
    expect(body).toContain("> **⚠️ Outside diff range comments (2)**");
    expect(body).toContain("> * _🟠 Major_ · Close the remote snapshot. · `src/a.ts:725`");
    expect(body).toContain("> * _🔴 Critical_ · Delete the uploaded object. · `src/a.ts:1501`");
  });

  it("names the bare file when the model gave no line to preserve", () => {
    const body = formatReviewBody(
      result([outsideComment({ title: "A blocker.", outsideDiff: { claimedLine: null } })]),
      META,
    );
    expect(body).toContain("> * _🟠 Major_ · A blocker. · `src/a.ts`");
  });

  // These are posted as real, resolvable file threads. Reprinting each finding
  // in full here would say everything twice — the thing formatReviewBody's
  // bucketing exists to prevent.
  it("previews rather than reprints the finding", () => {
    const body = formatReviewBody(result([outsideComment()]), META);
    expect(body).not.toContain("Prose.");
    expect(body).toContain("Each is posted as a file-scoped review thread");
  });

  it("sits above the collapsed sections", () => {
    const body = formatReviewBody(
      result([
        outsideComment(),
        {
          path: "src/a.ts",
          line: 2,
          side: "RIGHT",
          body: "_🟡 Minor_\n\n**Nit.**\n\nProse.",
          title: "Nit.",
          severity: "minor",
        },
      ]),
      META,
    );
    expect(body.indexOf("Outside diff range comments")).toBeLessThan(
      body.indexOf("🧹 Nitpick comments"),
    );
  });

  // Every real outside-diff finding is rated by construction (both
  // `outsideDiff:` call sites in ai/parse.ts gate on critical/major), but the
  // type still allows severity to be absent — this pins the defensive
  // fallback so a future violation of that invariant still renders something
  // severity-shaped instead of silently dropping a third of the row.
  it("renders a neutral marker for a finding carrying no severity", () => {
    const body = formatReviewBody(
      result([outsideComment({ title: "Unrated finding.", severity: undefined })]),
      META,
    );
    expect(body).toContain("> * _⚪ Unrated_ · Unrated finding. · `src/a.ts:501`");
  });

  it("stays out of the body when every finding anchored", () => {
    const body = formatReviewBody(
      result([
        {
          path: "src/a.ts",
          line: 2,
          side: "RIGHT",
          body: "_🟠 Major_\n\n**T.**\n\nProse.",
          title: "T.",
          severity: "major",
        },
      ]),
      META,
    );
    expect(body).not.toContain("Outside diff range comments");
  });
});
