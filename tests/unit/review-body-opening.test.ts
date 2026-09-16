import { describe, it, expect } from "vitest";
import { formatReviewBody, type ReviewBodyMeta } from "../../src/review-body.js";
import type { ReviewResult } from "../../src/types.js";

const META: ReviewBodyMeta = {
  profile: "chill",
  owner: "mk7luke",
  repo: "DiffSentry",
  headSha: "abc1234",
  baseBranch: "main",
  headBranch: "feat/x",
  filesProcessed: ["src/a.ts"],
  botName: "diffsentry",
};

const NARRATIVE =
  "This PR replaces the regex-based Markdown filter with an allowlist and adds regression coverage.";

function review(partial: Partial<ReviewResult> = {}): ReviewResult {
  return { summary: NARRATIVE, comments: [], approval: "COMMENT", ...partial };
}

/** The first line after the optional parse-failure banner. */
function opening(body: string): string {
  return body.split("\n\n").find((s) => s.trim().length > 0) ?? "";
}

describe("review body opening", () => {
  it("goes from the header straight into structured blocks", () => {
    const body = formatReviewBody(review(), META);
    expect(opening(body)).toBe("**Actionable comments posted: 0**");
    expect(body).not.toContain(NARRATIVE);
  });

  it("still opens with the header when there are findings", () => {
    const body = formatReviewBody(
      review({
        comments: [
          { path: "src/a.ts", line: 4, body: "Guard this.", title: "Guard", severity: "major", type: "issue" },
        ],
      }),
      META,
    );
    expect(opening(body)).toBe("**Actionable comments posted: 1**");
    expect(body).not.toContain(NARRATIVE);
  });

  it("keeps the narrative when no walkthrough will carry it", () => {
    const body = formatReviewBody(review(), { ...META, walkthroughPosted: false });
    expect(body).toContain(NARRATIVE);
    // Still after the header, never in front of it.
    expect(body.indexOf("**Actionable comments posted: 0**")).toBeLessThan(body.indexOf(NARRATIVE));
  });

  it("leads with the parse-failure banner rather than any prose", () => {
    const body = formatReviewBody(review({ parseFailed: true }), META);
    expect(body.startsWith("> [!CAUTION]")).toBe(true);
    expect(body).not.toContain(NARRATIVE);
  });

  it("suppresses the narrative on a findingless parse failure even with no walkthrough", () => {
    const body = formatReviewBody(review({ parseFailed: true }), {
      ...META,
      walkthroughPosted: false,
    });
    expect(body).not.toContain(NARRATIVE);
  });
});
