import { afterAll, describe, expect, it, beforeEach } from "vitest";

// Persistence off before dispatch's recordEvent import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { dispatchWebhookEvent, WebhookDispatchDeps } from "../../src/webhook/dispatch.js";

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
  function threadPayload(body: string): any {
    return {
      action: "created",
      installation: { id: 1 },
      repository: { owner: { login: "acme" }, name: "app" },
      pull_request: { number: 7 },
      comment: { id: 99, body, user: { type: "User" } },
    };
  }

  it("passes a slash command through verbatim", async () => {
    // Regression guard: the implicit-reply path prepends "@bot " to free-form
    // replies. Doing that to "/review" would turn a command into a chat message.
    await dispatchWebhookEvent(makeDeps(), "pull_request_review_comment", threadPayload("/review"));
    await settle();
    expect(handled).toEqual([{ kind: "thread", body: "/review" }]);
  });

  it("ignores a reply that only looks like a command", async () => {
    // "/shrug" is not ours and not a typo of ours. On a thread we did not
    // start, there is nothing to answer.
    const res = await dispatchWebhookEvent(
      makeDeps(), "pull_request_review_comment", threadPayload("/shrug"),
    );
    await settle();
    expect(res.status).toBe(202); // passes the loose gate…
    expect(handled).toEqual([{ kind: "thread", body: "/shrug" }]); // …and no-ops in parse
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
