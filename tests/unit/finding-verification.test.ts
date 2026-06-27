import { describe, it, expect } from "vitest";
import { parseReviewResponse } from "../../src/ai/parse.js";
import { verifyFindings, selectVerifierDiffs } from "../../src/ai/verify.js";
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

  it("skips findings whose file has no usable patch and keeps them fail-open, remapping indices", async () => {
    // Interleave a skipped finding (empty-patch file) BEFORE a verifiable one so
    // the verdict index must be remapped back to the original comment index.
    const context = {
      files: [
        { filename: "src/empty.ts", status: "modified" as const, patch: "   ", additions: 0, deletions: 0 },
        { filename: "src/a.ts", status: "modified" as const, patch: PATCH, additions: 2, deletions: 0 },
      ],
    };
    const cmts: ReviewComment[] = [
      { path: "src/empty.ts", line: 1, side: "RIGHT", body: "b", title: "On empty-patch file." },
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "b", title: "On real diff." },
    ];
    let sentUser = "";
    const ai = {
      complete: async (_s: string, u: string) => {
        sentUser = u;
        // verifiable subset has exactly one finding at index 0 (the a.ts one).
        return JSON.stringify({ verdicts: [{ index: 0, supported: false }] });
      },
    };
    const out = await verifyFindings({ ai, context, comments: cmts });
    // The a.ts finding (real diff) was dropped; the empty-patch finding is kept.
    expect(out.comments.map((c) => c.title)).toEqual(["On empty-patch file."]);
    expect(out.stats.skipped).toBe(1);
    expect(out.stats.dropped).toBe(1);
    // The skipped finding's file must never be sent to the verifier.
    expect(sentUser).not.toContain("src/empty.ts");
    expect(sentUser).toContain("src/a.ts");
  });

  it("does not call the AI when no finding has a usable patch (all skipped, kept)", async () => {
    const context = {
      files: [{ filename: "src/empty.ts", status: "modified" as const, patch: "", additions: 0, deletions: 0 }],
    };
    const cmts: ReviewComment[] = [
      { path: "src/empty.ts", line: 1, side: "RIGHT", body: "b", title: "Unverifiable." },
    ];
    let called = false;
    const ai = { complete: async () => { called = true; return "{}"; } };
    const out = await verifyFindings({ ai, context, comments: cmts });
    expect(called).toBe(false);
    expect(out.comments).toHaveLength(1);
    expect(out.stats.skipped).toBe(1);
    expect(out.stats.dropped).toBe(0);
  });

  it("keeps a verifiable finding whose diff was omitted by the prompt budget (fail-open)", async () => {
    // 8k per file, 32k total → the 5th file's patch is omitted; a finding on it
    // must be kept even if the verifier marks it unsupported, because the
    // verifier never saw its diff.
    const big = "y".repeat(8001);
    const files = Array.from({ length: 5 }, (_v, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified" as const,
      patch: big,
      additions: 1,
      deletions: 0,
    }));
    const cmts: ReviewComment[] = files.map((f, i) => ({
      path: f.filename,
      line: 2,
      side: "RIGHT" as const,
      body: "b",
      title: `Finding ${i}.`,
    }));
    // Verifier marks every finding it's shown unsupported.
    let sentUser = "";
    const ai = {
      complete: async (_s: string, u: string) => {
        sentUser = u;
        return JSON.stringify({ verdicts: cmts.map((_c, i) => ({ index: i, supported: false })) });
      },
    };
    const out = await verifyFindings({ ai, context: { files }, comments: cmts });
    // The omitted-file finding survives; only the in-budget ones can be dropped.
    expect(out.comments.some((c) => c.path === "src/f4.ts")).toBe(true);
    // It is counted as skipped and never sent to the verifier.
    expect(out.stats.skipped).toBeGreaterThanOrEqual(1);
    expect(sentUser).not.toContain("src/f4.ts");
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

describe("selectVerifierDiffs: bounded diff selection", () => {
  it("includes diffs only for referenced files", () => {
    const context = {
      files: [
        { filename: "src/a.ts", status: "modified" as const, patch: "patch-AAA", additions: 1, deletions: 0 },
        { filename: "src/unref.ts", status: "modified" as const, patch: "patch-ZZZ", additions: 1, deletions: 0 },
      ],
    };
    const { blocks, includedFiles } = selectVerifierDiffs(context, new Set(["src/a.ts"]));
    const joined = blocks.join("\n");
    expect(includedFiles.has("src/a.ts")).toBe(true);
    expect(includedFiles.has("src/unref.ts")).toBe(false);
    expect(joined).toContain("patch-AAA");
    expect(joined).not.toContain("patch-ZZZ");
  });

  it("excludes a referenced file with an empty patch", () => {
    const context = {
      files: [{ filename: "src/empty.ts", status: "modified" as const, patch: "   ", additions: 0, deletions: 0 }],
    };
    const { blocks, includedFiles } = selectVerifierDiffs(context, new Set(["src/empty.ts"]));
    expect(includedFiles.size).toBe(0);
    expect(blocks).toHaveLength(0);
  });

  it("truncates an oversized patch and marks the truncation", () => {
    const huge = "x".repeat(20000);
    const context = {
      files: [{ filename: "src/a.ts", status: "modified" as const, patch: huge, additions: 1, deletions: 0 }],
    };
    const { blocks, includedFiles } = selectVerifierDiffs(context, new Set(["src/a.ts"]));
    expect(includedFiles.has("src/a.ts")).toBe(true);
    expect(blocks[0]).toContain("patch truncated for verification");
    expect(blocks[0].length).toBeLessThan(huge.length);
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
