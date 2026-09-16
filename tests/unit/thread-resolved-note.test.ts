import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  Reviewer,
  THREAD_RESOLVED_NOTE,
  THREAD_RESOLVE_FAILED_NOTE,
} from "../../src/reviewer.js";

/**
 * DiffSentry already judges whether a review-thread conversation settled the
 * finding, and already collapses the thread when it did. What it never said was
 * that it had. A thread folding shut mid-conversation with no word reads as a
 * glitch — and the failure case was worse: when GitHub refused the mutation the
 * thread just stayed open, indistinguishable from one DiffSentry meant to leave
 * open.
 *
 * This is not the same machinery as the `✅ Addressed in commit(s) …` note.
 * That one is push-triggered and needs per-finding commit state to say
 * anything. This one is conversation-triggered, needs no persisted state at
 * all, and is a receipt for a mutation just attempted. They share an outcome
 * and nothing else.
 */

function reviewerWith(opts: { verdict: string; resolveSucceeds: boolean; threadFound?: boolean }) {
  const replies: string[] = [];
  const chat = vi
    .fn()
    .mockResolvedValueOnce("Agreed — the existing guard already covers this.")
    .mockResolvedValue(opts.verdict);

  const github = {
    getPRContext: vi.fn().mockResolvedValue({ headSha: "abc123", defaultBranch: "main", files: [] }),
    // No .diffsentry.yaml — loadRepoConfig treats a 404 as "use defaults".
    getInstallationOctokit: vi.fn().mockResolvedValue({
      repos: { getContent: vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { status: 404 })) },
    }),
    findThreadByCommentId: vi
      .fn()
      .mockResolvedValue(
        opts.threadFound === false
          ? null
          : { threadId: "T_1", isResolved: false, originalBody: "Guard this call." },
      ),
    resolveThreadById: vi.fn().mockResolvedValue(opts.resolveSucceeds),
    replyToComment: vi.fn().mockImplementation(async (..._args: unknown[]) => {
      replies.push(_args[5] as string);
    }),
  };

  const reviewer = Object.create(Reviewer.prototype) as InstanceType<typeof Reviewer>;
  Object.assign(reviewer as unknown as Record<string, unknown>, {
    github,
    ai: { chat },
    config: { botName: "diffsentry" },
    slashOptions: () => ({}),
    syncReviewCommitStatus: vi.fn().mockResolvedValue(true),
  });
  return { reviewer, github, replies };
}

const ASK = "@diffsentry that guard already exists upstream";

describe("the review-thread resolution receipt", () => {
  it("rides along on the reply, after the prose", async () => {
    const { reviewer, replies } = reviewerWith({ verdict: "YES", resolveSucceeds: true });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "review_thread");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      `Agreed — the existing guard already covers this.\n\n${THREAD_RESOLVED_NOTE}`,
    );
  });

  it("says the thread is still open when GitHub refused the mutation", async () => {
    // Without this the author sees a thread DiffSentry tried and failed to
    // close and one it deliberately left open as the same thing.
    const { reviewer, replies } = reviewerWith({ verdict: "YES", resolveSucceeds: false });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "review_thread");

    expect(replies[0].endsWith(THREAD_RESOLVE_FAILED_NOTE)).toBe(true);
  });

  it("says nothing when the judge declined to resolve", async () => {
    const { reviewer, replies, github } = reviewerWith({ verdict: "NO", resolveSucceeds: true });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "review_thread");

    expect(github.resolveThreadById).not.toHaveBeenCalled();
    expect(replies[0]).toBe("Agreed — the existing guard already covers this.");
  });

  it("says nothing when the comment was not in a review thread", async () => {
    // A top-level issue comment has no thread to resolve; claiming one was
    // would be a straight falsehood.
    const { reviewer, replies, github } = reviewerWith({ verdict: "YES", resolveSucceeds: true });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "issue");

    expect(github.findThreadByCommentId).not.toHaveBeenCalled();
    expect(replies[0]).toBe("Agreed — the existing guard already covers this.");
  });

  it("says nothing when no thread could be found for the comment", async () => {
    const { reviewer, replies } = reviewerWith({
      verdict: "YES",
      resolveSucceeds: true,
      threadFound: false,
    });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "review_thread");

    expect(replies[0]).toBe("Agreed — the existing guard already covers this.");
  });

  it("posts exactly one comment either way", async () => {
    // The corpus shape is one comment carrying prose then the receipt, not a
    // reply followed by a second bot comment announcing the collapse.
    const { reviewer, github } = reviewerWith({ verdict: "YES", resolveSucceeds: true });

    await reviewer.handleComment(1, "o", "r", 7, ASK, 42, "review_thread");

    expect(github.replyToComment).toHaveBeenCalledTimes(1);
  });
});

describe("the receipt wording", () => {
  it("matches the success form CodeRabbit posts", () => {
    const corpus = fs.readFileSync(
      path.join(process.cwd(), "tests/e2e/reference/2026-09/coderabbit/inline.md"),
      "utf8",
    );
    expect(corpus).toContain(`\n${THREAD_RESOLVED_NOTE}\n`);
  });

  it("matches the failure form the drift capture records", () => {
    const drift = fs.readFileSync(
      path.join(process.cwd(), "tests/e2e/reference/2026-09/drift.md"),
      "utf8",
    );
    expect(drift).toContain(THREAD_RESOLVE_FAILED_NOTE);
  });
});
