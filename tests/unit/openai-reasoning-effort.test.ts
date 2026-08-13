import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIProvider } from "../../src/ai/openai.js";

// OpenAI's `reasoning_effort` alphabet shifted mid-5.x: gpt-5.0–5.4 accept
// "minimal" and reject "none", gpt-5.5+ do the reverse. `createWithReasoningRetry`
// recovers from a wrong guess, but only after spending a round-trip, so the
// opening guess needs to match the family. These tests pin both branches.

let received: Record<string, unknown>[];
let server: http.Server;
let baseURL: string;

beforeEach(async () => {
  received = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test",
          choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function effortSentFor(model: string): Promise<unknown> {
  await new OpenAIProvider("sk-test", model, baseURL).complete("sys", "usr", { json: true });
  return received[0].reasoning_effort;
}

describe("OpenAIProvider initial reasoning_effort guess", () => {
  it("opens with 'none' for gpt-5.5 and later", async () => {
    expect(await effortSentFor("gpt-5.6-terra")).toBe("none");
  });

  it("opens with 'none' for a bare gpt-5.5", async () => {
    expect(await effortSentFor("gpt-5.5")).toBe("none");
  });

  it("opens with 'minimal' for gpt-5.0 through 5.4", async () => {
    expect(await effortSentFor("gpt-5.4")).toBe("minimal");
  });

  it("treats an unsuffixed gpt-5 as 5.0, not 5.5+", async () => {
    expect(await effortSentFor("gpt-5-mini")).toBe("minimal");
  });

  // Comparing versions as decimals makes Number("5.10") === 5.1, which sorts
  // gpt-5.10 BELOW gpt-5.5 and hands it the retired "minimal" alphabet.
  it("orders two-digit minor versions above 5.5, not below", async () => {
    expect(await effortSentFor("gpt-5.10")).toBe("none");
  });

  it("keeps later majors on the newer alphabet", async () => {
    expect(await effortSentFor("gpt-6")).toBe("none");
  });

  it("uses 'low' for the o-series, which rejects 'minimal'", async () => {
    expect(await effortSentFor("o4-mini")).toBe("low");
  });

  it("sends nothing for a non-reasoning model", async () => {
    await new OpenAIProvider("sk-test", "gpt-4o", baseURL).complete("sys", "usr", { json: true });
    expect(received[0]).not.toHaveProperty("reasoning_effort");
  });
});
