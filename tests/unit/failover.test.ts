import { describe, it, expect, vi } from "vitest";
import { FailoverProvider } from "../../src/ai/failover.js";
import { AiTimeoutError } from "../../src/ai/timeout.js";
import type { AIProvider, ReviewResult, PRContext } from "../../src/types.js";

function ctx(): PRContext {
  return {
    owner: "o", repo: "r", pullNumber: 1, title: "t", description: "",
    baseBranch: "main", headBranch: "feat", headSha: "sha", files: [], diff: "",
  } as unknown as PRContext;
}

function review(summary: string): ReviewResult {
  return { summary, comments: [], approval: "COMMENT" };
}

/** Minimal fake provider; only the methods a test exercises are stubbed. */
function fakeProvider(over: Partial<AIProvider>): AIProvider {
  const notImpl = () => { throw new Error("not stubbed"); };
  return {
    review: over.review ?? (notImpl as AIProvider["review"]),
    generateWalkthrough: over.generateWalkthrough ?? (notImpl as AIProvider["generateWalkthrough"]),
    chat: over.chat ?? (notImpl as AIProvider["chat"]),
    chatIssue: over.chatIssue ?? (notImpl as AIProvider["chatIssue"]),
    complete: over.complete ?? (notImpl as AIProvider["complete"]),
  };
}

const OPTS = { circuitThreshold: 3, circuitCooldownMs: 60_000 };

describe("FailoverProvider", () => {
  it("returns the primary result and never calls the backup on success", async () => {
    const backupReview = vi.fn();
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockResolvedValue(review("primary")) }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    const res = await p.review(ctx());
    expect(res.summary).toBe("primary");
    expect(res.servedBy).toBeUndefined();
    expect(backupReview).not.toHaveBeenCalled();
  });

  it("fails over to the backup on a transient primary error and tags servedBy", async () => {
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000)) }),
      fakeProvider({ review: vi.fn().mockResolvedValue(review("backup")) }),
      OPTS,
    );
    const res = await p.review(ctx());
    expect(res.summary).toBe("backup");
    expect(res.servedBy).toBe("backup");
  });

  it("does NOT fail over on a 401 and rethrows", async () => {
    const backupReview = vi.fn();
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    await expect(p.review(ctx())).rejects.toThrow("unauthorized");
    expect(backupReview).not.toHaveBeenCalled();
  });

  it("rethrows the backup error when both fail", async () => {
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000)) }),
      fakeProvider({ review: vi.fn().mockRejectedValue(new Error("backup down")) }),
      OPTS,
    );
    await expect(p.review(ctx())).rejects.toThrow("backup down");
  });

  it("opens the breaker after threshold consecutive transient failures, then routes straight to backup", async () => {
    const primaryReview = vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000));
    const backupReview = vi.fn().mockResolvedValue(review("backup"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    // 3 failing-then-failover calls trip the breaker.
    await p.review(ctx());
    await p.review(ctx());
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(3);
    // 4th call: breaker open → primary skipped entirely.
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(3);
    expect(backupReview).toHaveBeenCalledTimes(4);
  });

  it("half-opens after cooldown; a primary success closes the breaker", async () => {
    let clock = 1_000;
    const now = () => clock;
    const primaryReview = vi
      .fn()
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockResolvedValue(review("primary-recovered"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: vi.fn().mockResolvedValue(review("backup")) }),
      { ...OPTS, now },
    );
    await p.review(ctx()); await p.review(ctx()); await p.review(ctx()); // breaker opens
    clock += 60_001; // cooldown elapsed → half-open probe hits primary
    const res = await p.review(ctx());
    expect(res.summary).toBe("primary-recovered");
    expect(res.servedBy).toBeUndefined(); // primary served
  });

  it("re-opens the breaker for a fresh cooldown when the half-open probe fails", async () => {
    let clock = 1_000;
    const now = () => clock;
    // Primary fails every time; backup always serves.
    const primaryReview = vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000));
    const backupReview = vi.fn().mockResolvedValue(review("backup"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: backupReview }),
      { ...OPTS, now },
    );
    await p.review(ctx()); await p.review(ctx()); await p.review(ctx()); // breaker opens (3 probes)
    expect(primaryReview).toHaveBeenCalledTimes(3);

    clock += 60_001; // cooldown elapsed → next call is a half-open probe on the primary
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(4); // probe hit the primary...

    // ...and its failure must re-arm the cooldown. The immediately-following call
    // stays on the backup instead of re-probing the just-failed primary.
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(4); // primary skipped — breaker re-opened
    expect(backupReview).toHaveBeenCalledTimes(5);
  });

  it("resets consecutive failures on a primary success", async () => {
    const primaryReview = vi
      .fn()
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockResolvedValueOnce(review("ok"))       // resets counter
      .mockRejectedValue(new AiTimeoutError("primary", "review", 20000));
    const backupReview = vi.fn().mockResolvedValue(review("backup"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    await p.review(ctx()); await p.review(ctx()); // 2 failures
    await p.review(ctx());                        // success → reset
    await p.review(ctx());                        // 1 failure (breaker still closed)
    expect(primaryReview).toHaveBeenCalledTimes(4); // primary always attempted (never skipped)
  });

  it("delegates the non-review methods and fails them over too", async () => {
    const p = new FailoverProvider(
      fakeProvider({
        generateWalkthrough: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "walkthrough", 20000)),
        chat: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "chat", 20000)),
        chatIssue: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "issue_chat", 20000)),
        complete: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "complete", 20000)),
      }),
      fakeProvider({
        generateWalkthrough: vi.fn().mockResolvedValue({ summary: "wt", fileDescriptions: [] }),
        chat: vi.fn().mockResolvedValue("chat-backup"),
        chatIssue: vi.fn().mockResolvedValue("issue-backup"),
        complete: vi.fn().mockResolvedValue("complete-backup"),
      }),
      OPTS,
    );
    expect((await p.generateWalkthrough(ctx())).summary).toBe("wt");
    expect(await p.chat(ctx(), "hi")).toBe("chat-backup");
    expect(await p.chatIssue({} as never, "hi")).toBe("issue-backup");
    expect(await p.complete("sys", "usr")).toBe("complete-backup");
  });
});
