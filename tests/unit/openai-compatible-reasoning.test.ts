import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../../src/ai/openai-compatible.js";
import type { PRContext } from "../../src/types.js";

// The adapter reaches hosted reasoning models (grok-4.5 and friends) as well as
// local runtimes, and the two want opposite things: a hosted reasoner needs a
// low `reasoning_effort` and a roomy token budget or its hidden chain-of-thought
// eats the whole completion, while a local runtime 400s on the field entirely.
// These tests drive a real loopback /v1/chat/completions server so they assert
// what actually goes on the wire rather than what we meant to send.

const PATCH = ["@@ -1,2 +1,3 @@", " context line", "+added line", " trailing line"].join("\n");

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
    files: [{ filename: "src/a.ts", status: "modified", patch: PATCH, additions: 1, deletions: 0 }],
  };
}

/** Bodies of every request the fake endpoint received, in order. */
let received: Record<string, unknown>[];
/** Set to make the next request fail the way a backend rejects the field. */
let rejectReasoningEffortOnce: boolean;
let server: http.Server;
let baseURL: string;

function completionBody(content: string) {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

beforeEach(async () => {
  received = [];
  rejectReasoningEffortOnce = false;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      received.push(body);
      if (rejectReasoningEffortOnce) {
        rejectReasoningEffortOnce = false;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Unrecognized request argument supplied: reasoning_effort",
              type: "invalid_request_error",
              param: "reasoning_effort",
              code: "unknown_parameter",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completionBody(JSON.stringify({ comments: [], summary: "ok" })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function provider(reasoningEffort?: string) {
  return new OpenAICompatibleProvider({ baseURL, model: "grok-4.5", reasoningEffort });
}

describe("openai-compatible reasoning_effort", () => {
  it("sends no reasoning_effort and keeps the 4096 review budget when unconfigured", async () => {
    await provider().review(ctx());
    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("reasoning_effort");
    expect(received[0].max_tokens).toBe(4096);
  });

  it("sends the configured effort and widens the review budget for reasoning headroom", async () => {
    await provider("low").review(ctx());
    expect(received).toHaveLength(1);
    expect(received[0].reasoning_effort).toBe("low");
    expect(received[0].max_tokens).toBe(16384);
  });

  it("floors complete()'s caller budget so hidden reasoning can't consume it whole", async () => {
    // verify.ts asks for 1024 — enough for its verdict JSON, but nowhere near
    // enough once the same budget also has to cover chain-of-thought.
    await provider("low").complete("sys", "usr", { json: true, maxTokens: 1024 });
    expect(received[0].max_tokens).toBe(4096);
    expect(received[0].reasoning_effort).toBe("low");
  });

  it("sends the effort on non-JSON complete() too — the connectivity probe", async () => {
    // reviewer.ts probes with { maxTokens: 16 } and no json flag, then reports
    // the round-trip as a health latency. Omitting the effort there would leave
    // the probe reasoning at the model's default.
    await provider("low").complete("probe", "ping", { maxTokens: 16 });
    expect(received[0].reasoning_effort).toBe("low");
    expect(received[0]).not.toHaveProperty("response_format");
  });

  // tokenBudgetFor widens the budget for chat too, so omitting the effort there
  // would leave the model reasoning at its default inside a wider cap.
  it("sends the effort on the chat surfaces as well", async () => {
    const p = provider("low");
    await p.chat(ctx(), "why did this change?");
    expect(received[0].reasoning_effort).toBe("low");
    expect(received[0].max_tokens).toBe(8192);

    received.length = 0;
    await p.chatIssue(
      { owner: "o", repo: "r", issueNumber: 1, title: "t", body: "", state: "open", labels: [], url: "u", comments: [] },
      "hi",
    );
    expect(received[0].reasoning_effort).toBe("low");
  });

  it("leaves complete()'s budget alone when no reasoning effort is configured", async () => {
    await provider().complete("sys", "usr", { json: true, maxTokens: 1024 });
    expect(received[0].max_tokens).toBe(1024);
    expect(received[0]).not.toHaveProperty("reasoning_effort");
  });

  it("retries without the field when the backend rejects it, then stops sending it", async () => {
    const p = provider("low");
    rejectReasoningEffortOnce = true;

    // Fails open: the retry succeeds, so the caller sees a normal result.
    await p.review(ctx());
    expect(received).toHaveLength(2);
    expect(received[0].reasoning_effort).toBe("low");
    expect(received[1]).not.toHaveProperty("reasoning_effort");

    // The rejection is remembered — no second wasted round-trip.
    await p.review(ctx());
    expect(received).toHaveLength(3);
    expect(received[2]).not.toHaveProperty("reasoning_effort");
  });

  // The wider budget exists to leave room for hidden chain-of-thought. Once the
  // endpoint has refused the field there is no such reasoning, and holding 16384
  // would hand a small-context local runtime a max_tokens it cannot serve.
  it("reverts to the legacy budgets after the endpoint rejects the field", async () => {
    const p = provider("low");
    rejectReasoningEffortOnce = true;
    await p.review(ctx());          // rejected, then retried without the field
    received.length = 0;

    await p.review(ctx());
    expect(received[0].max_tokens).toBe(4096);
    expect(received[0]).not.toHaveProperty("reasoning_effort");

    received.length = 0;
    await p.complete("sys", "usr", { json: true, maxTokens: 1024 });
    expect(received[0].max_tokens).toBe(1024);
  });

  it("does not swallow a 400 that has nothing to do with reasoning_effort", async () => {
    const p = provider("low");
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "context length exceeded", param: "messages" } }));
    });
    await expect(p.review(ctx())).rejects.toThrow();
  });
});
