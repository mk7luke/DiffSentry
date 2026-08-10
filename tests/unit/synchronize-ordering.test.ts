import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Persistence off before dispatch's recordEvent import chain runs.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

const order: string[] = [];

vi.mock("../../src/realtime/jobs.js", () => ({
  runReviewJob: vi.fn(async () => {
    order.push("review");
  }),
}));

const { dispatchWebhookEvent } = await import("../../src/webhook/dispatch.js");
type Deps = Parameters<typeof dispatchWebhookEvent>[0];

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

/**
 * Push auto-resolve retires the dedup fingerprints of every thread it closes,
 * and the review pass builds its dedup set from that same state the moment it
 * starts. Run side by side, the pass reads the pre-retirement set and drops its
 * own re-raise of a finding auto-resolve had just closed on nothing more than
 * "the file changed" — leaving the PR green with the finding neither on it nor
 * fixed. The chaining is the only thing keeping those two in order.
 */
function makeDeps(over: { autoResolve?: () => Promise<void> } = {}): Deps {
  return {
    botName: "diffsentry",
    reviewer: {
      autoResolveOnPush: async () => {
        await (over.autoResolve?.() ?? Promise.resolve());
        order.push("auto-resolve");
      },
    } as unknown as Deps["reviewer"],
  } as Deps;
}

function syncPayload(): any {
  return {
    action: "synchronize",
    installation: { id: 1 },
    repository: { owner: { login: "acme" }, name: "app" },
    pull_request: { number: 7, draft: false },
  };
}

/** Dispatch is fire-and-forget; let the chained continuations drain. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  order.length = 0;
});

describe("synchronize", () => {
  it("queues the review only after push auto-resolve has finished", async () => {
    const res = await dispatchWebhookEvent(
      makeDeps({ autoResolve: () => new Promise((r) => setTimeout(r, 5)) }),
      "pull_request",
      syncPayload(),
    );

    // The webhook still answers immediately — the chain runs behind the response.
    expect(res.status).toBe(202);
    await settle();
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual(["auto-resolve", "review"]);
  });

  it("still queues the review when auto-resolve throws", async () => {
    // Auto-resolve is best-effort bookkeeping; the review is the product.
    const res = await dispatchWebhookEvent(
      makeDeps({ autoResolve: () => Promise.reject(new Error("503")) }),
      "pull_request",
      syncPayload(),
    );

    expect(res.status).toBe(202);
    await settle();

    expect(order).toContain("review");
  });
});
