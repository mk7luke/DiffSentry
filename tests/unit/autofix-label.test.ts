import { describe, it, expect } from "vitest";
import { formatReviewBody } from "../../src/review-body.js";
import type { ReviewComment, ReviewResult } from "../../src/types.js";

describe("Autofix label", () => {
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

  const comment: ReviewComment = {
    path: "src/a.ts",
    line: 7,
    side: "RIGHT",
    body: "body",
    type: "issue",
    severity: "major",
    title: "Guard the nullable branch.",
  };

  it("drops the (Beta) qualifier without touching the checkbox contract", () => {
    const result: ReviewResult = { summary: "s", comments: [comment], approval: "COMMENT" };
    const body = formatReviewBody(result, META);
    expect(body).toContain("<summary>🪄 Autofix</summary>");
    expect(body).not.toContain("Autofix (Beta)");
    expect(body).toContain("Push a commit to this branch (recommended)");
    expect(body).toContain("Create a new PR with the fixes");
  });
});
