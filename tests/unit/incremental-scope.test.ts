import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../../src/ai/prompt.js";
import { parseReviewResponse } from "../../src/ai/parse.js";
import {
  buildPriorReviewContext,
  dropContextOnlyFindings,
  partitionFilesForReview,
} from "../../src/reviewer.js";
import type { FileChange, PRContext, ReviewComment } from "../../src/types.js";

// Regression coverage for "DiffSentry ignores the rest of the PR once you push
// another commit". Companion to drift-scope.test.ts, which fixed the same class
// of false positive for the *drift* pass only.
//
// On a synchronize push the reviewer trims context.files to the delta, then
// hands the model that slice together with the WHOLE-PR title and description —
// and a system prompt that explicitly asks for a PR-level finding when "a
// claimed change is missing". The model duly reports that the feature the
// description promises was never implemented. Observed on
// mk7luke/atlas-timeclock#89: a docs-only follow-up commit turned an approved
// feature branch into "Claimed overlay implementation is missing from the
// diff." + REQUEST_CHANGES, naming the four files that had been reviewed and
// accepted a week earlier.

function file(filename: string, marker = "changed"): FileChange {
  return {
    filename,
    status: "modified",
    patch: `@@ -1,2 +1,3 @@\n context\n+${marker} ${filename}\n`,
    additions: 1,
    deletions: 0,
  };
}

function ctx(files: FileChange[], over: Partial<PRContext> = {}): PRContext {
  return {
    owner: "o",
    repo: "r",
    pullNumber: 89,
    title: "Stamp date/time onto served selfies",
    description:
      "Adds config.selfie_timestamp_overlay, images.render_timestamp_overlay(), " +
      "stamped responses in the selfies router, and tests.",
    baseBranch: "main",
    headBranch: "feat",
    headSha: "deadbee",
    files,
    ...over,
  };
}

describe("incremental review — the model sees the rest of the PR", () => {
  it("shows the already-reviewed files' diffs as read-only context", () => {
    const prompt = buildReviewPrompt(
      ctx([file(".env.example")], {
        priorReview: { files: [file("backend/app/images.py", "render_timestamp_overlay")] },
      }),
    );

    // The earlier commit's actual diff reaches the model...
    expect(prompt.user).toContain("render_timestamp_overlay backend/app/images.py");
    // ...labelled so it is never mistaken for something to comment on again.
    expect(prompt.user).toContain("Already reviewed earlier in this PR");
    expect(prompt.user).toMatch(/do NOT comment on these/i);
  });

  it("tells the model the diff is partial and absence proves nothing", () => {
    const prompt = buildReviewPrompt(
      ctx([file(".env.example")], {
        priorReview: { files: [file("backend/app/config.py")] },
      }),
    );

    expect(prompt.user).toMatch(/incremental review/i);
    expect(prompt.user).toMatch(/not evidence/i);
    // The description covers the whole branch, not just the newest commit.
    expect(prompt.user).toMatch(/ENTIRE pull request/i);
  });

  it("still names the earlier files when there is no budget headroom for their diffs", () => {
    const prompt = buildReviewPrompt(
      ctx([file(".env.example")], {
        priorReview: {
          files: [file("backend/app/images.py", "render_timestamp_overlay")],
          namesOnly: true,
        },
      }),
    );

    expect(prompt.user).toContain("backend/app/images.py");
    // Named, not shown — the patch body must not be spent.
    expect(prompt.user).not.toContain("render_timestamp_overlay backend/app/images.py");
    expect(prompt.user).toMatch(/not evidence/i);
  });

  it("honors the prior-context budget: truncated patches and omitted files are labelled", () => {
    const prior = [file("a.py", "kept"), file("b.py", "dropped")];
    const budget = buildPriorReviewContext({
      files: prior,
      cfg: { per_file_chars: 60, per_review_chars: 200 },
      usedChars: 0,
    });

    const prompt = buildReviewPrompt(ctx([file("c.py")], { priorReview: budget }));

    // Whatever the budget dropped is named rather than silently vanishing —
    // a file the model can't see must never read as a file that doesn't exist.
    for (const f of prior) expect(prompt.user).toContain(f.filename);
  });

  it("adds nothing to a full review's prompt", () => {
    const prompt = buildReviewPrompt(ctx([file("src/a.ts")]));

    expect(prompt.user).not.toContain("Already reviewed earlier in this PR");
    expect(prompt.user).not.toMatch(/incremental review/i);
  });

  it("forbids description-vs-diff findings when the diff shown is partial", () => {
    const prompt = buildReviewPrompt(ctx([file("src/a.ts")]));

    // System-prompt guard: the "claimed change is missing" rule must carve out
    // the case where the model was only shown part of the change set.
    expect(prompt.system).toMatch(/partial/i);
  });
});

describe("context files are read, not re-reviewed", () => {
  function finding(path: string, line = 3): ReviewComment {
    return { path, line, side: "RIGHT", body: "b", title: "t", type: "issue", severity: "major" };
  }

  const prior = { files: [file("old.ts"), file("older.ts")] };

  it("drops inline findings raised against an already-reviewed file", () => {
    const kept = dropContextOnlyFindings(
      [finding("new.ts"), finding("old.ts"), finding("older.ts")],
      prior,
    );

    expect(kept.map((c) => c.path)).toEqual(["new.ts"]);
  });

  it("keeps PR-level findings — whole-PR reasoning is the point of the context", () => {
    const kept = dropContextOnlyFindings([finding("", 0), finding("old.ts")], prior);

    expect(kept).toHaveLength(1);
    expect(kept[0].path).toBe("");
  });

  it("keeps a PR-level finding that names an already-reviewed file", () => {
    // A PR-level finding is recognised by its flag, not by an empty path. Now
    // that one can name the file it concerns, matching on path alone would
    // silently swallow the whole-PR claims this context exists to enable — "the
    // README documents a command this compose change doesn't support" is about
    // a file the newest commit didn't touch.
    const prLevel: ReviewComment = { ...finding("old.ts", 0), prLevel: true };
    const kept = dropContextOnlyFindings([prLevel, finding("old.ts")], prior);

    expect(kept).toHaveLength(1);
    expect(kept[0].prLevel).toBe(true);
  });

  it("is a no-op on a full review", () => {
    const comments = [finding("a.ts"), finding("b.ts")];

    expect(dropContextOnlyFindings(comments, undefined)).toBe(comments);
  });

  it("a file-scoped finding from the inline channel can never name a context-only file", () => {
    // Why exempting every `prLevel` finding above is safe rather than a hole.
    // `prLevel` spans two origins: whole-PR claims that named a file (drift,
    // prLevelComments) and inline findings demoted for want of a line. Only the
    // first should out-scope this guard — but the second can never reach it,
    // because partitionFilesForReview puts a file in EITHER filesToReview or
    // filesSkippedSimilar, reviewer.ts narrows context.files to the former, and
    // parseReviewResponse drops any comment naming a file outside it.
    //
    // That invariant is load-bearing and lives three functions away, so pin it
    // here: if context.files ever widens to include already-reviewed files, a
    // demoted finding could name one and this exemption would start re-posting
    // findings on context-only files — exactly what the guard exists to stop.
    const files = [file("old.ts"), file("new.ts")];
    const seed = partitionFilesForReview(files, "full", undefined);
    const part = partitionFilesForReview(files, "incremental", { "old.ts": seed.currentFileShas["old.ts"] });

    expect(part.filesSkippedSimilar).toEqual(["old.ts"]);
    expect(part.filesToReview.map((f) => f.filename)).toEqual(["new.ts"]);
    expect(part.filesToReview.filter((f) => part.filesSkippedSimilar.includes(f.filename))).toEqual([]);

    const ctx: PRContext = {
      owner: "o", repo: "r", pullNumber: 1, title: "t", description: "",
      baseBranch: "main", headBranch: "feat", headSha: "dead", files: part.filesToReview,
    };
    const res = parseReviewResponse(
      JSON.stringify({
        summary: "", approval: "REQUEST_CHANGES",
        comments: [{ path: "old.ts", title: "Blocking, no line.", body: "b", severity: "major" }],
      }),
      ctx,
    );
    expect(res.comments).toHaveLength(0);
  });
});

describe("buildPriorReviewContext", () => {
  const cfg = { per_file_chars: 1000, per_review_chars: 10_000 };

  it("returns nothing when every file in the PR is in this review", () => {
    expect(buildPriorReviewContext({ files: [], cfg, usedChars: 0 })).toBeUndefined();
  });

  it("budgets the earlier patches against the headroom the delta left", () => {
    const result = buildPriorReviewContext({
      files: [file("a.ts"), file("b.ts")],
      cfg,
      usedChars: 500,
    });

    expect(result?.files.map((f) => f.filename)).toEqual(["a.ts", "b.ts"]);
    expect(result?.namesOnly).toBeFalsy();
    expect(result?.budget).toBeDefined();
  });

  it("degrades to names-only rather than overrunning the review budget", () => {
    // The delta plus related context already consumed nearly the whole budget:
    // there isn't room for even one more file, so send names, not patches.
    const result = buildPriorReviewContext({
      files: [file("a.ts")],
      cfg,
      usedChars: 9_500,
    });

    expect(result?.namesOnly).toBe(true);
    expect(result?.budget).toBeUndefined();
  });

  it("sends full patches when diff budgeting is disabled", () => {
    const result = buildPriorReviewContext({
      files: [file("a.ts")],
      cfg: { enabled: false },
      usedChars: 1_000_000,
    });

    expect(result?.namesOnly).toBeFalsy();
    expect(result?.budget).toBeUndefined();
  });

  it("pairs with partitionFilesForReview: prior files are exactly the skipped-similar set", () => {
    const files = [file("backend/app/images.py"), file("backend/app/config.py"), file(".env.example")];
    const first = partitionFilesForReview(files, "full", undefined);
    const priorShas = {
      "backend/app/images.py": first.currentFileShas["backend/app/images.py"],
      "backend/app/config.py": first.currentFileShas["backend/app/config.py"],
    };

    const second = partitionFilesForReview(files, "incremental", priorShas);
    const prior = buildPriorReviewContext({
      files: second.allFiles.filter((f) => second.filesSkippedSimilar.includes(f.filename)),
      cfg,
      usedChars: 0,
    });

    expect(second.filesToReview.map((f) => f.filename)).toEqual([".env.example"]);
    expect(prior?.files.map((f) => f.filename)).toEqual([
      "backend/app/images.py",
      "backend/app/config.py",
    ]);
  });
});
