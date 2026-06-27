import { describe, it, expect } from "vitest";
import { parseReviewResponse } from "../../src/ai/parse.js";
import { verifyFindings, buildVerificationPrompt } from "../../src/ai/verify.js";
import { formatReviewBody } from "../../src/review-body.js";
import type { PRContext, ReviewComment, ReviewResult } from "../../src/types.js";

// A small diff: right-side line numbers are
//   1 (context), 2 (+added), 3 (+added), 4 (context), 5 (context).
// So valid = {1,2,3,4,5}, changed (+) lines = [2, 3].
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

function reviewJson(comments: Array<{ path: string; line: number; title: string }>): string {
  return JSON.stringify({
    summary: "",
    approval: "COMMENT",
    comments: comments.map((c) => ({
      ...c,
      body: "body text",
      type: "issue",
      severity: "major",
      aiAgentPrompt: "do the thing",
    })),
  });
}

describe("parse: line remapping", () => {
  it("keeps a finding that already lands on a valid diff line", () => {
    const res = parseReviewResponse(reviewJson([{ path: "src/a.ts", line: 3, title: "On a real line." }]), ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].line).toBe(3);
  });

  it("remaps a near-miss line to the nearest changed line instead of dropping it", () => {
    // line 6 is not in the diff; nearest changed line is 3 (distance 3).
    const res = parseReviewResponse(reviewJson([{ path: "src/a.ts", line: 6, title: "Slightly off." }]), ctx());
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].line).toBe(3);
  });

  it("drops a finding whose line is far from any diff line (no valid anchor)", () => {
    const res = parseReviewResponse(reviewJson([{ path: "src/a.ts", line: 500, title: "Hallucinated location." }]), ctx());
    expect(res.comments).toHaveLength(0);
  });

  it("drops a finding referencing an unknown file", () => {
    const res = parseReviewResponse(reviewJson([{ path: "src/missing.ts", line: 2, title: "Wrong file." }]), ctx());
    expect(res.comments).toHaveLength(0);
  });
});

describe("verifyFindings", () => {
  const comments: ReviewComment[] = [
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "b0", title: "Finding zero." },
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "b1", title: "Finding one." },
  ];

  it("skips the call entirely when there are no findings", async () => {
    let called = false;
    const ai = { complete: async () => { called = true; return "{}"; } };
    const out = await verifyFindings({ ai, context: ctx(), comments: [] });
    expect(called).toBe(false);
    expect(out.comments).toHaveLength(0);
    expect(out.stats.before).toBe(0);
  });

  it("drops only the findings the verifier marks unsupported", async () => {
    const ai = {
      complete: async () =>
        JSON.stringify({ verdicts: [
          { index: 0, supported: false, citedLines: [] },
          { index: 1, supported: true, citedLines: [3] },
        ] }),
    };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0].title).toBe("Finding one.");
    expect(out.stats.dropped).toBe(1);
    expect(out.stats.unparseable).toBe(false);
  });

  it("fails open (keeps all findings) when the verifier output can't be parsed", async () => {
    const ai = { complete: async () => "not json at all" };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments).toHaveLength(2);
    expect(out.stats.dropped).toBe(0);
    expect(out.stats.unparseable).toBe(true);
  });

  it("keeps a finding the verifier omitted a verdict for (per-finding fail-open)", async () => {
    const ai = {
      complete: async () => JSON.stringify({ verdicts: [{ index: 0, supported: false }] }),
    };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments.map((c) => c.title)).toEqual(["Finding one."]);
  });

  it("ignores duplicate index verdicts deterministically (first verdict wins)", async () => {
    // index 0 is first marked supported, then a conflicting unsupported dup —
    // first-wins keeps it; index 1's first (and only) verdict drops it.
    const ai = {
      complete: async () =>
        JSON.stringify({ verdicts: [
          { index: 0, supported: true },
          { index: 0, supported: false },
          { index: 1, supported: false },
          { index: 1, supported: true },
        ] }),
    };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments.map((c) => c.title)).toEqual(["Finding zero."]);
    expect(out.stats.dropped).toBe(1);
  });
});

describe("buildVerificationPrompt: bounded prompt", () => {
  it("embeds diffs only for files referenced by a finding", () => {
    const context = {
      files: [
        { filename: "src/a.ts", status: "modified" as const, patch: "patch-AAA", additions: 1, deletions: 0 },
        { filename: "src/unref.ts", status: "modified" as const, patch: "patch-ZZZ", additions: 1, deletions: 0 },
      ],
    };
    const comments: ReviewComment[] = [
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "b", title: "Only references a.ts." },
    ];
    const { user } = buildVerificationPrompt(context, comments);
    expect(user).toContain("src/a.ts");
    expect(user).toContain("patch-AAA");
    expect(user).not.toContain("src/unref.ts");
    expect(user).not.toContain("patch-ZZZ");
  });

  it("truncates an oversized patch and marks the truncation", () => {
    const huge = "x".repeat(20000);
    const context = {
      files: [{ filename: "src/a.ts", status: "modified" as const, patch: huge, additions: 1, deletions: 0 }],
    };
    const comments: ReviewComment[] = [
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "b", title: "Big file." },
    ];
    const { user } = buildVerificationPrompt(context, comments);
    expect(user).toContain("patch truncated for verification");
    // The embedded patch must be well under the original size.
    expect(user.length).toBeLessThan(huge.length);
  });
});

describe("review-body: honest parse-failure rendering", () => {
  const meta = {
    profile: "chill",
    owner: "o",
    repo: "r",
    headSha: "deadbee",
    baseBranch: "main",
    headBranch: "feat",
    filesProcessed: ["src/a.ts"],
    botName: "diffsentry",
  };

  it("renders a clear failure banner and suppresses the misleading summary when parse failed with no findings", () => {
    const result: ReviewResult = {
      summary: "Reviewed 1 file. No actionable findings — see the walkthrough above for an overview of what changed.",
      comments: [],
      approval: "COMMENT",
      summaryIsFallback: true,
      parseFailed: true,
    };
    const body = formatReviewBody(result, meta);
    expect(body).toContain("could not complete this review");
    expect(body).toContain("will retry this review");
    expect(body).not.toContain("No actionable findings");
    expect(body).not.toMatch(/no concerns surfaced/i);
  });

  it("still shows a real finding summary under the banner when built-in checks found something", () => {
    const result: ReviewResult = {
      summary: "Reviewed 1 file and surfaced 1 finding (1 critical). See inline comments for details.",
      comments: [
        { path: "src/a.ts", line: 2, side: "RIGHT", body: "secret", title: "Secret in code.", severity: "critical", type: "security" },
      ],
      approval: "REQUEST_CHANGES",
      summaryIsFallback: true,
      parseFailed: true,
    };
    const body = formatReviewBody(result, meta);
    expect(body).toContain("could not complete this review");
    expect(body).toContain("surfaced 1 finding");
  });

  it("renders no failure banner on a normal review", () => {
    const result: ReviewResult = {
      summary: "Reviewed 1 file. No concerns surfaced — the change looks safe to merge.",
      comments: [],
      approval: "APPROVE",
    };
    const body = formatReviewBody(result, meta);
    expect(body).not.toContain("could not complete this review");
    expect(body).toContain("No concerns surfaced");
  });
});
