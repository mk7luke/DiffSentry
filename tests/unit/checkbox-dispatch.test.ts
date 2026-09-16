import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Persistence off before dispatch's recordEvent import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { dispatchWebhookEvent, WebhookDispatchDeps } from "../../src/webhook/dispatch.js";
import { REVIEW_BODY_MARKER } from "../../src/review-body.js";
import { WALKTHROUGH_MARKER } from "../../src/walkthrough.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

interface Handled {
  body: string;
  commentId: number;
  kind?: string;
}

let handled: Handled[] = [];

function makeDeps(): WebhookDispatchDeps {
  return {
    botName: "diffsentry",
    reviewer: {
      handleComment: async (_i, _o, _r, _n, body, commentId, kind) => {
        handled.push({ body, commentId, kind });
      },
      handleIssueComment: async () => {},
      getInstallationOctokit: async () => {
        throw new Error("not used");
      },
      reconsiderAutoReleaseNotes: async () => {},
    } as unknown as WebhookDispatchDeps["reviewer"],
  };
}

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  handled = [];
});

function meta(id: string, action: string, delivery: string): string {
  return JSON.stringify({ checkboxId: id, action, delivery });
}

// ─── The walkthrough comment ────────────────────────────────────────────────

function walkthroughPayload(body: string, from: string, userType = "Bot"): unknown {
  return {
    action: "edited",
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    issue: { number: 7, pull_request: {} },
    comment: { id: 99, body: `${WALKTHROUGH_MARKER}\n${body}`, user: { type: userType } },
    changes: { body: { from: `${WALKTHROUGH_MARKER}\n${from}` } },
  };
}

describe("finishing-touches checkboxes on the walkthrough", () => {
  it("dispatches a stacked delivery with the --stacked flag", async () => {
    const m = meta("a", "generate_docstrings", "stacked");
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "issue_comment",
      walkthroughPayload(`- [x] <!-- ${m} --> Create stacked PR`, `- [ ] <!-- ${m} --> Create stacked PR`),
    );
    await settle();
    expect(res.status).toBe(202);
    expect(handled).toEqual([
      { body: "@diffsentry generate docstrings --stacked", commentId: 99, kind: undefined },
    ]);
  });

  it("dispatches a branch delivery with no flag", async () => {
    const m = meta("a", "simplify", "branch");
    await dispatchWebhookEvent(
      makeDeps(),
      "issue_comment",
      walkthroughPayload(
        `- [x] <!-- ${m} --> Commit simplified code in branch \`feat\``,
        `- [ ] <!-- ${m} --> Commit simplified code in branch \`feat\``,
      ),
    );
    await settle();
    expect(handled.map((h) => h.body)).toEqual(["@diffsentry simplify"]);
  });

  it("still refuses a user-authored comment that pastes the marker", async () => {
    const m = meta("a", "autofix", "stacked");
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "issue_comment",
      walkthroughPayload(`- [x] <!-- ${m} --> Create stacked PR`, `- [ ] <!-- ${m} --> Create stacked PR`, "User"),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });
});

// ─── The review body ────────────────────────────────────────────────────────

function reviewPayload(
  body: string,
  from: string,
  opts: { userType?: string; marker?: boolean } = {},
): unknown {
  const marker = opts.marker === false ? "" : `\n${REVIEW_BODY_MARKER}`;
  return {
    action: "edited",
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    pull_request: { number: 7 },
    review: { id: 5, body: `${body}${marker}`, user: { type: opts.userType ?? "Bot" } },
    changes: { body: { from: `${from}${marker}` } },
  };
}

const AUTOFIX_PR = meta("np", "autofix", "stacked");
const AUTOFIX_COMMIT = meta("cm", "autofix", "branch");

describe("the 🪄 Autofix checkboxes in the review body", () => {
  it("acts on `Create a new PR with the fixes`, which used to do nothing at all", async () => {
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(
        `- [x] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
        `- [ ] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
      ),
    );
    await settle();
    expect(res.status).toBe(202);
    expect(handled).toEqual([
      { body: "@diffsentry autofix --stacked", commentId: 0, kind: "issue" },
    ]);
  });

  it("acts on the commit-to-branch box too", async () => {
    await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(
        `- [x] <!-- ${AUTOFIX_COMMIT} --> Push a commit to this branch (recommended)`,
        `- [ ] <!-- ${AUTOFIX_COMMIT} --> Push a commit to this branch (recommended)`,
      ),
    );
    await settle();
    expect(handled.map((h) => h.body)).toEqual(["@diffsentry autofix"]);
  });

  it("ignores a review body that is not ours", async () => {
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(
        `- [x] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
        `- [ ] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
        { marker: false },
      ),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("ignores a human review even when it carries our marker", async () => {
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(
        `- [x] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
        `- [ ] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
        { userType: "User" },
      ),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("ignores an edit that flipped no box", async () => {
    const line = `- [ ] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`;
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(`${line}\nrewrote the summary`, line),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("leaves a submitted review alone", async () => {
    const payload = reviewPayload(
      `- [x] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
      "",
    ) as Record<string, unknown>;
    payload.action = "submitted";
    const res = await dispatchWebhookEvent(makeDeps(), "pull_request_review", payload);
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("runs one delivery, not two, when both boxes are ticked at once", async () => {
    const before = [
      `- [ ] <!-- ${AUTOFIX_COMMIT} --> Push a commit to this branch (recommended)`,
      `- [ ] <!-- ${AUTOFIX_PR} --> Create a new PR with the fixes`,
    ].join("\n");
    await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(before.replace(/- \[ \]/g, "- [x]"), before),
    );
    await settle();
    expect(handled.map((h) => h.body)).toEqual(["@diffsentry autofix --stacked"]);
  });
});

describe("a second destination ticked in a second edit", () => {
  const line = (m: string, checked: boolean, label: string) =>
    `- [${checked ? "x" : " "}] <!-- ${m} --> ${label}`;
  const bothBoxes = (commit: boolean, pr: boolean) =>
    [
      line(AUTOFIX_COMMIT, commit, "Push a commit to this branch (recommended)"),
      line(AUTOFIX_PR, pr, "Create a new PR with the fixes"),
    ].join("\n");

  it("delivers once, not twice, when the user changes their mind after the commit", async () => {
    // Edit 1: tick the commit box. A commit lands on the head branch.
    await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(bothBoxes(true, false), bothBoxes(false, false)),
    );
    await settle();
    expect(handled.map((h) => h.body)).toEqual(["@diffsentry autofix"]);

    // Edit 2: tick the stacked box as well. Without the cross-edit rule this
    // opened a stacked PR carrying the same fixes the branch already has.
    handled = [];
    const res = await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(bothBoxes(true, true), bothBoxes(true, false)),
    );
    await settle();
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("still lets the user switch destination by unticking first", async () => {
    await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(bothBoxes(false, false), bothBoxes(true, false)),
    );
    await settle();
    expect(handled).toEqual([]);

    await dispatchWebhookEvent(
      makeDeps(),
      "pull_request_review",
      reviewPayload(bothBoxes(false, true), bothBoxes(false, false)),
    );
    await settle();
    expect(handled.map((h) => h.body)).toEqual(["@diffsentry autofix --stacked"]);
  });
});
