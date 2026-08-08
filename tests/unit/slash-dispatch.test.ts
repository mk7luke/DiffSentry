import { afterAll, describe, expect, it, beforeEach } from "vitest";

// Persistence off before dispatch's recordEvent import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { dispatchWebhookEvent, WebhookDispatchDeps } from "../../src/webhook/dispatch.js";
import { parseCommand } from "../../src/commands.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

interface Handled {
  kind: "pr" | "issue" | "thread";
  body: string;
}

let handled: Handled[] = [];

/** Structural stub of the narrow WebhookReviewer surface dispatch needs. */
function makeDeps(overrides: Partial<WebhookDispatchDeps> = {}): WebhookDispatchDeps {
  return {
    botName: "diffsentry",
    reviewer: {
      handleComment: async (_i, _o, _r, _n, body, _c, kind) => {
        handled.push({ kind: kind === "review_thread" ? "thread" : "pr", body });
      },
      handleIssueComment: async (_i, _o, _r, _n, body) => {
        handled.push({ kind: "issue", body });
      },
      getInstallationOctokit: async () => {
        throw new Error("not used");
      },
    } as unknown as WebhookDispatchDeps["reviewer"],
    ...overrides,
  };
}

function issueCommentPayload(body: string, onPR = true): any {
  return {
    action: "created",
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    issue: { number: 7, ...(onPR ? { pull_request: {} } : {}), user: { type: "User" } },
    comment: { id: 99, body, user: { type: "User" } },
  };
}

/** Dispatch is fire-and-forget; let the microtask queue drain. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  handled = [];
});

describe("webhook gate — slash commands", () => {
  it("accepts a bare slash command on a PR", async () => {
    const res = await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload("/review"));
    await settle();
    expect(res.status).toBe(202);
    expect(handled).toEqual([{ kind: "pr", body: "/review" }]);
  });

  it("accepts a namespaced slash command on a PR", async () => {
    await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload("/diffsentry review"));
    await settle();
    expect(handled).toEqual([{ kind: "pr", body: "/diffsentry review" }]);
  });

  it("accepts a slash command on an issue", async () => {
    await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload("/summary", false));
    await settle();
    expect(handled).toEqual([{ kind: "issue", body: "/summary" }]);
  });

  it("still accepts mentions", async () => {
    await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload("@diffsentry review"));
    await settle();
    expect(handled).toHaveLength(1);
  });

  it("ignores ordinary comments", async () => {
    const res = await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload("LGTM, merging"));
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("ignores a slash command inside a code block", async () => {
    const body = ["Repro:", "```sh", "/review", "```"].join("\n");
    const res = await dispatchWebhookEvent(makeDeps(), "issue_comment", issueCommentPayload(body));
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("ignores bot-authored comments even when they contain commands", async () => {
    const payload = issueCommentPayload("/review");
    payload.comment.user.type = "Bot";
    await dispatchWebhookEvent(makeDeps(), "issue_comment", payload);
    await settle();
    expect(handled).toEqual([]);
  });

  it("honors the master switch", async () => {
    const deps = makeDeps({ slashCommands: false });
    await dispatchWebhookEvent(deps, "issue_comment", issueCommentPayload("/review"));
    await settle();
    expect(handled).toEqual([]);
  });

  it("honors the bare switch while keeping the namespace", async () => {
    const deps = makeDeps({ bareSlashCommands: false });
    await dispatchWebhookEvent(deps, "issue_comment", issueCommentPayload("/review"));
    await settle();
    expect(handled).toEqual([]);

    await dispatchWebhookEvent(deps, "issue_comment", issueCommentPayload("/diffsentry review"));
    await settle();
    expect(handled).toEqual([{ kind: "pr", body: "/diffsentry review" }]);
  });
});

describe("webhook gate — review thread replies", () => {
  function threadPayload(body: string, replyToId?: number): any {
    return {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "acme" }, name: "app" },
      pull_request: { number: 7 },
      comment: { id: 99, body, user: { type: "User" }, in_reply_to_id: replyToId },
    };
  }

  /** Deps whose parent-comment lookup reports a thread our bot started. */
  function depsOnOurThread(): WebhookDispatchDeps {
    const deps = makeDeps();
    (deps.reviewer as any).getInstallationOctokit = async () => ({
      pulls: {
        getReviewComment: async () => ({
          data: { user: { type: "Bot", login: "diffsentry[bot]" } },
        }),
      },
    });
    return deps;
  }

  it("dispatches a standalone slash command on any thread", async () => {
    await dispatchWebhookEvent(makeDeps(), "pull_request_review_comment", threadPayload("/review"));
    await settle();
    expect(handled).toEqual([{ kind: "thread", body: "/review" }]);
  });

  it("forwards a non-command slash reply, which then no-ops in parse", async () => {
    // "/shrug" is neither ours nor a typo of ours. It passes the loose gate and
    // parseCommand drops it — the bot stays silent on a thread it does not own.
    const res = await dispatchWebhookEvent(
      makeDeps(), "pull_request_review_comment", threadPayload("/shrug"),
    );
    await settle();
    expect(res.status).toBe(202);
    expect(handled).toEqual([{ kind: "thread", body: "/shrug" }]);
    expect(parseCommand("/shrug", "diffsentry")).toBeNull(); // the actual no-op
  });

  // ─── Implicit replies, on threads our bot started ─────────────

  it("keeps a slash command intact on our own thread", async () => {
    // Regression guard: the implicit-reply path prepends "@bot " to free-form
    // replies. Doing that to "/review" would turn a command into a chat message.
    await dispatchWebhookEvent(
      depsOnOurThread(), "pull_request_review_comment", threadPayload("/review", 555),
    );
    await settle();
    expect(handled).toEqual([{ kind: "thread", body: "/review" }]);
    expect(parseCommand("/review", "diffsentry")).toEqual({ type: "review" });
  });

  it("rewrites a non-command slash reply on our thread into chat", async () => {
    // This is the case the prepend exists for: conversation that happens to
    // start with a slash must reach chat, not be dropped.
    await dispatchWebhookEvent(
      depsOnOurThread(), "pull_request_review_comment", threadPayload("/shrug", 555),
    );
    await settle();
    expect(handled).toEqual([{ kind: "thread", body: "@diffsentry /shrug" }]);
    expect(parseCommand("@diffsentry /shrug", "diffsentry")).toEqual({
      type: "chat",
      message: "/shrug",
    });
  });

  it("rewrites ordinary prose on our thread into chat", async () => {
    await dispatchWebhookEvent(
      depsOnOurThread(), "pull_request_review_comment", threadPayload("why is that unsafe?", 555),
    );
    await settle();
    expect(handled).toEqual([{ kind: "thread", body: "@diffsentry why is that unsafe?" }]);
  });

  it("ignores an unrelated reply that is not on our thread", async () => {
    const res = await dispatchWebhookEvent(
      makeDeps(), "pull_request_review_comment", threadPayload("agreed, nice catch"),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });
});

describe("webhook gate — review thread resolution", () => {
  /** Deps that record every refreshReviewCommitStatus call. */
  function makeRefreshDeps() {
    const refreshed: Array<{ owner: string; repo: string; pr: number }> = [];
    const deps = makeDeps();
    (deps.reviewer as any).refreshReviewCommitStatus = async (
      _i: number, owner: string, repo: string, pr: number,
    ) => {
      refreshed.push({ owner, repo, pr });
      return true;
    };
    return { deps, refreshed };
  }

  function resolvedPayload(over: Record<string, unknown> = {}): any {
    return {
      action: "resolved",
      installation: { id: 1 },
      repository: { owner: { login: "acme" }, name: "app" },
      pull_request: { number: 7 },
      thread: { node_id: "PRRT_x" },
      ...over,
    };
  }

  it("refreshes the review status when a human resolves a thread", async () => {
    // The gap this closes: clicking "Resolve conversation" in the GitHub UI is
    // the only way to clear a thread that fires no other event we listen to.
    const { deps, refreshed } = makeRefreshDeps();
    const res = await dispatchWebhookEvent(deps, "pull_request_review_thread", resolvedPayload());
    await settle();
    expect(res.status).toBe(202);
    expect(refreshed).toEqual([{ owner: "acme", repo: "app", pr: 7 }]);
  });

  it("ignores un-resolution rather than inventing a failing status", async () => {
    // The refresh only ever clears a failure DiffSentry wrote; re-opening a
    // thread is not grounds for writing one no review pass produced.
    const { deps, refreshed } = makeRefreshDeps();
    const res = await dispatchWebhookEvent(
      deps, "pull_request_review_thread", resolvedPayload({ action: "unresolved" }),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(refreshed).toEqual([]);
  });

  it("ignores a payload with no installation", async () => {
    const { deps, refreshed } = makeRefreshDeps();
    const res = await dispatchWebhookEvent(
      deps, "pull_request_review_thread", resolvedPayload({ installation: undefined }),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(refreshed).toEqual([]);
  });

  it("ignores a payload with no PR number", async () => {
    const { deps, refreshed } = makeRefreshDeps();
    const res = await dispatchWebhookEvent(
      deps, "pull_request_review_thread", resolvedPayload({ pull_request: {} }),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(refreshed).toEqual([]);
  });

  it("still answers 202 when the refresh itself fails", async () => {
    // Fire-and-forget: a GitHub outage must not turn into a webhook 5xx and a
    // GitHub redelivery storm.
    const deps = makeDeps();
    (deps.reviewer as any).refreshReviewCommitStatus = async () => {
      throw new Error("503");
    };
    const res = await dispatchWebhookEvent(deps, "pull_request_review_thread", resolvedPayload());
    await settle();
    expect(res.status).toBe(202);
  });
});
