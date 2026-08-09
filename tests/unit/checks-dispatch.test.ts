import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Persistence off before dispatch's recordEvent import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { dispatchWebhookEvent, WebhookDispatchDeps } from "../../src/webhook/dispatch.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

let evaluated: string[] = [];

function makeDeps(): WebhookDispatchDeps {
  return {
    botName: "diffsentry",
    reviewer: {
      handleChecksCompleted: async (_i: number, _o: string, _r: string, headSha: string) => {
        evaluated.push(headSha);
      },
    } as unknown as WebhookDispatchDeps["reviewer"],
  };
}

function checkSuitePayload(action: string, over: Record<string, unknown> = {}): any {
  return {
    action,
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    check_suite: { head_sha: SHA, status: "completed", conclusion: "success" },
    ...over,
  };
}

function statusPayload(over: Record<string, unknown> = {}): any {
  return {
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    sha: SHA,
    state: "success",
    context: "ci/jenkins",
    ...over,
  };
}

/** Dispatch is fire-and-forget; let the microtask queue drain. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  evaluated = [];
});

describe("check_suite", () => {
  it("evaluates release notes when a suite completes", async () => {
    const res = await dispatchWebhookEvent(makeDeps(), "check_suite", checkSuitePayload("completed"));
    await settle();
    expect(res.status).toBe(202);
    expect(evaluated).toEqual([SHA]);
  });

  it("evaluates on a failed suite too, because other suites decide the aggregate", async () => {
    // One suite's conclusion is not the verdict. A suite that failed and was
    // re-run green completes as `failure` on an earlier attempt and the payload
    // alone would have us skip the commit forever.
    await dispatchWebhookEvent(
      makeDeps(),
      "check_suite",
      checkSuitePayload("completed", { check_suite: { head_sha: SHA, conclusion: "failure" } }),
    );
    await settle();
    expect(evaluated).toEqual([SHA]);
  });

  it("ignores a suite that has only just been requested", async () => {
    for (const action of ["requested", "rerequested"]) {
      const res = await dispatchWebhookEvent(makeDeps(), "check_suite", checkSuitePayload(action));
      await settle();
      expect(res.body).toEqual({ status: "ignored" });
    }
    expect(evaluated).toEqual([]);
  });

  it("ignores a payload with no installation or no head SHA", async () => {
    await dispatchWebhookEvent(makeDeps(), "check_suite", checkSuitePayload("completed", { installation: undefined }));
    await dispatchWebhookEvent(makeDeps(), "check_suite", checkSuitePayload("completed", { check_suite: {} }));
    await settle();
    expect(evaluated).toEqual([]);
  });
});

describe("status", () => {
  it("evaluates release notes when a legacy status lands", async () => {
    const res = await dispatchWebhookEvent(makeDeps(), "status", statusPayload());
    await settle();
    expect(res.status).toBe(202);
    expect(evaluated).toEqual([SHA]);
  });

  it("ignores a pending status", async () => {
    // It cannot be the write that turns the PR green.
    await dispatchWebhookEvent(makeDeps(), "status", statusPayload({ state: "pending" }));
    await settle();
    expect(evaluated).toEqual([]);
  });

  it("ignores DiffSentry's own status writes", async () => {
    // Loop safety. Resolving a thread makes the app write this status, and
    // acting on the delivery would have the app re-read every check on the
    // commit in response to an event it raised itself.
    for (const context of ["DiffSentry", "DiffSentry / Pre-Merge"]) {
      await dispatchWebhookEvent(makeDeps(), "status", statusPayload({ context }));
    }
    await settle();
    expect(evaluated).toEqual([]);
  });

  it("still acts on a repo job whose name merely starts with DiffSentry", async () => {
    await dispatchWebhookEvent(makeDeps(), "status", statusPayload({ context: "DiffSentry integration tests" }));
    await settle();
    expect(evaluated).toEqual([SHA]);
  });
});
