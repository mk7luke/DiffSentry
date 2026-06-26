import { describe, it, expect } from "vitest";
import {
  withAiTimeout,
  AiTimeoutError,
  isAiTimeoutError,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
} from "../../src/ai/timeout.js";

describe("withAiTimeout", () => {
  it("resolves the wrapped call when it finishes in time", async () => {
    const result = await withAiTimeout(
      { provider: "anthropic", operation: "review", timeoutMs: 1000 },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });

  it("rejects with a typed AiTimeoutError when the deadline passes", async () => {
    const never = new Promise<string>(() => {}); // never settles
    const err = await withAiTimeout(
      { provider: "openai", operation: "review", timeoutMs: 20 },
      () => never,
    ).catch((e) => e);

    expect(isAiTimeoutError(err)).toBe(true);
    expect(err).toBeInstanceOf(AiTimeoutError);
    expect(err.provider).toBe("openai");
    expect(err.operation).toBe("review");
    expect(err.timeoutMs).toBe(20);
    expect(String(err.message)).toContain("timed out");
  });

  it("aborts the signal handed to the call on timeout", async () => {
    let captured: AbortSignal | undefined;
    await withAiTimeout(
      { provider: "anthropic", operation: "chat", timeoutMs: 20 },
      (signal) => {
        captured = signal;
        return new Promise<string>(() => {}); // never settles
      },
    ).catch(() => {});

    expect(captured?.aborted).toBe(true);
  });

  it("does not run the call's post-success work (e.g. cost tracking) on timeout", async () => {
    // Mirrors how providers wrap a model call: the SDK call is the awaited
    // promise, and `track()` only runs after it resolves. A timeout must reject
    // before that, so usage is never recorded for a timed-out call.
    let tracked = false;
    await withAiTimeout(
      { provider: "openai", operation: "review", timeoutMs: 20 },
      async () => {
        await new Promise<void>(() => {}); // model call hangs
        tracked = true; // unreachable on timeout
        return "x";
      },
    ).catch(() => {});

    expect(tracked).toBe(false);
  });

  it("leaves the signal un-aborted when the call succeeds before the deadline", async () => {
    let captured: AbortSignal | undefined;
    const result = await withAiTimeout(
      { provider: "anthropic", operation: "complete", timeoutMs: 1000 },
      async (signal) => {
        captured = signal;
        return "done";
      },
    );
    expect(result).toBe("done");
    // Only an actual timeout aborts the signal — a successful call must not.
    expect(captured?.aborted).toBe(false);
  });

  it("propagates an ordinary error without aborting the signal", async () => {
    let captured: AbortSignal | undefined;
    const err = await withAiTimeout(
      { provider: "openai", operation: "review", timeoutMs: 1000 },
      async (signal) => {
        captured = signal;
        throw new Error("boom");
      },
    ).catch((e) => e);
    expect(isAiTimeoutError(err)).toBe(false);
    expect(String(err.message)).toBe("boom");
    // An ordinary failure isn't a cancellation, so the signal stays un-aborted.
    expect(captured?.aborted).toBe(false);
  });

  it("treats a non-positive timeout as 'no bound' and still resolves", async () => {
    const result = await withAiTimeout(
      { provider: "anthropic", operation: "complete", timeoutMs: 0 },
      async () => "unbounded",
    );
    expect(result).toBe("unbounded");
  });

  it("exposes a sane default deadline", () => {
    expect(DEFAULT_AI_REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});
