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

// A VALID unified diff with `lineCount` added right-side lines (1..lineCount).
// Each line is padded so the patch comfortably exceeds MAX_PATCH_CHARS_PER_FILE
// (8000), letting tests exercise per-file truncation with real line numbers.
function bigDiff(lineCount: number, pad = 60): string {
  const header = `@@ -1,${lineCount} +1,${lineCount} @@`;
  const lines = Array.from({ length: lineCount }, (_v, i) => `+L${i + 1} ${"a".repeat(pad)}`);
  return [header, ...lines].join("\n");
}

// A VALID diff of EXACTLY `chars` length (line numbers 1..n on the right side).
// Sized to fill the per-file budget precisely so tests can force whole-file
// omission (remaining <= 0) deterministically instead of relying on truncation
// slack. `chars` should be >= ~40.
function diffOfExactLength(chars: number): string {
  const parts: string[] = ["@@ -1,1000 +1,1000 @@"];
  let len = parts[0].length;
  let n = 0;
  for (;;) {
    const line = `\n+L${++n} ${"a".repeat(40)}`;
    if (len + line.length > chars) { n--; break; }
    parts.push(line);
    len += line.length;
  }
  let s = parts.join("");
  if (s.length < chars) s += "a".repeat(chars - s.length); // pad the last line exactly
  return s;
}

// Mock verifier that returns exactly one verdict per finding actually present
// in the prompt (counted from it), so the mock mirrors production's compacted
// index space. `unsupported(i)` decides each compacted finding's verdict.
function mockVerifier(captured: { user: string }, unsupported: (i: number) => boolean) {
  return {
    complete: async (_s: string, u: string) => {
      captured.user = u;
      const n = (u.match(/^Finding \d+:/gm) ?? []).length;
      return JSON.stringify({ verdicts: Array.from({ length: n }, (_x, i) => ({ index: i, supported: !unsupported(i) })) });
    },
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

  it("treats an incomplete verdict set (any finding unjudged) as unparseable and keeps all", async () => {
    // The verifier must return exactly one verdict per finding. A response that
    // judges only some of them (here index 0 of 2) is incomplete and not
    // trustworthy enough to delete a finding — we fail open and keep everything
    // rather than acting on a partial result.
    const ai = {
      complete: async () => JSON.stringify({ verdicts: [{ index: 0, supported: false }] }),
    };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments.map((c) => c.title)).toEqual(["Finding zero.", "Finding one."]);
    expect(out.stats.dropped).toBe(0);
    expect(out.stats.unparseable).toBe(true);
  });

  it("treats an empty/unusable verdict set as unparseable and keeps all findings", async () => {
    for (const payload of ['{"verdicts": []}', '{"verdicts": [{}]}', '{"verdicts": [{"index": 99, "supported": false}]}']) {
      const ai = { complete: async () => payload };
      const out = await verifyFindings({ ai, context: ctx(), comments });
      expect(out.comments).toHaveLength(2);
      expect(out.stats.dropped).toBe(0);
      expect(out.stats.unparseable).toBe(true);
    }
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
    // 5 large valid diffs; the per-file/total caps exhaust the budget before the
    // 5th, so f4's diff is never embedded. A finding on it must be kept even when
    // the verifier marks everything it WAS shown unsupported.
    const files = Array.from({ length: 5 }, (_v, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified" as const,
      patch: diffOfExactLength(8000),
      additions: 200,
      deletions: 0,
    }));
    const cmts: ReviewComment[] = files.map((f) => ({
      path: f.filename,
      line: 2, // an early line, always within the shown prefix of included files
      side: "RIGHT" as const,
      body: "b",
      title: `on ${f.filename}`,
    }));
    const captured = { user: "" };
    const out = await verifyFindings({ ai: mockVerifier(captured, () => true), context: { files }, comments: cmts });
    // f4 was never sent (budget-omitted) → kept fail-open; f0..f3 are dropped.
    expect(out.comments.map((c) => c.path)).toEqual(["src/f4.ts"]);
    expect(out.stats.dropped).toBe(4);
    expect(out.stats.skipped).toBe(1);
    expect(out.stats.unparseable).toBe(false);
    expect(captured.user).not.toContain("src/f4.ts");
  });

  it("maps compacted verdict indices back to non-contiguous original indices", async () => {
    // Budget-omit a file that sits in the MIDDLE of the comments array so the
    // surviving original indices are non-contiguous ([0,2,3,4]); the compacted
    // verifier index space is 0..3 and must map back correctly.
    const files = Array.from({ length: 5 }, (_v, i) => ({
      filename: `src/g${i}.ts`,
      status: "modified" as const,
      patch: diffOfExactLength(8000),
      additions: 200,
      deletions: 0,
    }));
    // Comments ordered so the omitted file (g4, last in file order) is NOT last
    // in the comments array → original indices of included findings = [0,2,3,4].
    const order = ["src/g0.ts", "src/g4.ts", "src/g1.ts", "src/g2.ts", "src/g3.ts"];
    const cmts: ReviewComment[] = order.map((path) => ({
      path,
      line: 2,
      side: "RIGHT" as const,
      body: "b",
      title: `on ${path}`,
    }));
    // included = [g0,g1,g2,g3]; mark only compacted index 2 (g2 → original
    // comments index 3) unsupported.
    const captured = { user: "" };
    const out = await verifyFindings({ ai: mockVerifier(captured, (i) => i === 2), context: { files }, comments: cmts });
    expect(out.comments.map((c) => c.path).sort()).toEqual(["src/g0.ts", "src/g1.ts", "src/g3.ts", "src/g4.ts"]);
    expect(out.comments.some((c) => c.path === "src/g2.ts")).toBe(false);
    expect(out.stats.dropped).toBe(1);
    expect(out.stats.skipped).toBe(1);
    expect(out.stats.unparseable).toBe(false);
    expect(captured.user).not.toContain("src/g4.ts");
  });

  it("keeps a finding whose supporting line was truncated out of an included file (fail-open)", async () => {
    // One oversized file: its prefix is shown, its tail is cut. A finding on a
    // visible (prefix) line is verified and can be dropped; a finding on a line
    // that only exists in the truncated tail must be kept fail-open.
    const context = {
      files: [{ filename: "src/big.ts", status: "modified" as const, patch: bigDiff(300), additions: 300, deletions: 0 }],
    };
    const cmts: ReviewComment[] = [
      { path: "src/big.ts", line: 2, side: "RIGHT", body: "b", title: "in shown prefix" },
      { path: "src/big.ts", line: 290, side: "RIGHT", body: "b", title: "in truncated tail" },
    ];
    // The verifier only sees the prefix finding and marks it unsupported.
    const captured = { user: "" };
    const out = await verifyFindings({ ai: mockVerifier(captured, () => true), context, comments: cmts });
    expect(out.comments.map((c) => c.title)).toEqual(["in truncated tail"]);
    expect(out.stats.dropped).toBe(1);
    expect(out.stats.skipped).toBe(1);
    expect(out.stats.unparseable).toBe(false);
  });

  it("treats duplicate index verdicts as malformed (unparseable) and keeps all", async () => {
    // A repeated index breaks the one-verdict-per-finding contract — here index 0
    // is contradictorily both supported and unsupported. We fail open rather than
    // arbitrarily trusting either copy.
    const ai = {
      complete: async () =>
        JSON.stringify({ verdicts: [
          { index: 0, supported: true },
          { index: 0, supported: false },
          { index: 1, supported: false },
        ] }),
    };
    const out = await verifyFindings({ ai, context: ctx(), comments });
    expect(out.comments).toHaveLength(2);
    expect(out.stats.dropped).toBe(0);
    expect(out.stats.unparseable).toBe(true);
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

  it("truncates an oversized multi-line patch at a line boundary and marks it", () => {
    const huge = bigDiff(300); // valid diff well over the 8k per-file cap
    const context = {
      files: [{ filename: "src/a.ts", status: "modified" as const, patch: huge, additions: 300, deletions: 0 }],
    };
    const { blocks, includedFiles } = selectVerifierDiffs(context, new Set(["src/a.ts"]));
    expect(includedFiles.has("src/a.ts")).toBe(true);
    expect(blocks[0]).toContain("patch truncated for verification");
    expect(blocks[0].length).toBeLessThan(huge.length);
    // The embedded slice ends on a real line boundary (no half-line at the tail).
    const body = blocks[0].split("```diff\n")[1].split("\n… (patch truncated")[0];
    expect(body.endsWith("a")).toBe(true); // a complete "+L… aaaa" line
  });

  it("omits a file whose oversized first line has no safe boundary (kept fail-open)", () => {
    // A single line longer than the cap with no newline within budget: we can't
    // truncate without cutting mid-line, so the file is omitted entirely.
    const context = {
      files: [{ filename: "src/min.ts", status: "modified" as const, patch: "x".repeat(20000), additions: 1, deletions: 0 }],
    };
    const { blocks, includedFiles } = selectVerifierDiffs(context, new Set(["src/min.ts"]));
    expect(includedFiles.size).toBe(0);
    expect(blocks).toHaveLength(0);
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
