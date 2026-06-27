import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithRetry } from "../../src/github.js";

// The rate-limit / transient-error backoff that wraps every Octokit instance
// (installation- and App-level) via octokit.hook.wrap("request", ...). We test
// the wrapped request function directly: a fake `request` lets us drive the
// 403/429/5xx paths and the AbortSignal short-circuit without a real network
// call or App credentials.

// Silences the backoff log lines so test output stays clean.
const quietLog = { warn: () => {} } as any;

/** Octokit RequestError-shaped failure: only `status` + response headers. */
function ghError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
}

/**
 * A fake Octokit `request` driven by a script of behaviours. Once the script is
 * exhausted the last behaviour repeats (so "always fails" is a single entry).
 */
function mockRequest(script: Array<{ throw?: Error; return?: unknown }>) {
  let calls = 0;
  const fn = async (_options: any) => {
    const step = script[Math.min(calls, script.length - 1)];
    calls++;
    if (step.throw) throw step.throw;
    return step.return;
  };
  return Object.assign(fn, { count: () => calls });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requestWithRetry", () => {
  it("returns the response untouched on first success (no retry)", async () => {
    const req = mockRequest([{ return: { data: "ok" } }]);
    await expect(requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog)).resolves.toEqual({
      data: "ok",
    });
    expect(req.count()).toBe(1);
  });

  it("retries a secondary rate-limit (retry-after) then succeeds", async () => {
    vi.useFakeTimers();
    const req = mockRequest([{ throw: ghError(429, { "retry-after": "1" }) }, { return: { data: "ok" } }]);
    const p = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ data: "ok" });
    expect(req.count()).toBe(2);
  });

  it("retries a primary rate-limit (403 + x-ratelimit-remaining: 0) then succeeds", async () => {
    vi.useFakeTimers();
    const reset = String(Math.floor(Date.now() / 1000) + 1);
    const req = mockRequest([
      { throw: ghError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }) },
      { return: { data: "ok" } },
    ]);
    const p = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ data: "ok" });
    expect(req.count()).toBe(2);
  });

  it("retries a transient 5xx with exponential backoff then succeeds", async () => {
    vi.useFakeTimers();
    const req = mockRequest([{ throw: ghError(502) }, { throw: ghError(503) }, { return: { data: "ok" } }]);
    const p = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ data: "ok" });
    expect(req.count()).toBe(3);
  });

  it("gives up after MAX_RETRIES (3) on a persistent rate-limit", async () => {
    vi.useFakeTimers();
    const req = mockRequest([{ throw: ghError(429, { "retry-after": "1" }) }]);
    // Attach the rejection handler before advancing timers so the rejection
    // (which happens mid-runAllTimersAsync) is never momentarily unhandled.
    const settled = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog).catch((e) => e);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toMatchObject({ status: 429 });
    expect(req.count()).toBe(4); // 1 initial attempt + 3 retries
  });

  // A malformed/zero/negative `retry-after` (from GitHub or an intermediary)
  // must NOT cause a zero-delay hot retry — it falls through to the
  // x-ratelimit-reset / default fallback wait instead.
  for (const bad of ["-1", "abc", "0"]) {
    it(`ignores a non-positive/malformed retry-after (${JSON.stringify(bad)}) and uses the fallback wait`, async () => {
      vi.useFakeTimers();
      const req = mockRequest([{ throw: ghError(429, { "retry-after": bad }) }, { return: { data: "ok" } }]);
      const settled = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog).then(
        (r) => r,
        (e) => e
      );

      // Flush microtasks only (0ms). A buggy zero-delay path would already
      // have fired the retry here; the fallback wait (BASE_BACKOFF_MS = 1s)
      // means the request has been attempted exactly once so far.
      await vi.advanceTimersByTimeAsync(0);
      expect(req.count()).toBe(1);

      // Once the ~1s fallback elapses, it retries and succeeds.
      await vi.advanceTimersByTimeAsync(1000);
      await expect(settled).resolves.toEqual({ data: "ok" });
      expect(req.count()).toBe(2);
    });
  }

  it("falls back to x-ratelimit-reset when retry-after is negative", async () => {
    vi.useFakeTimers();
    const reset = String(Math.floor(Date.now() / 1000) + 2);
    const req = mockRequest([
      { throw: ghError(429, { "retry-after": "-5", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }) },
      { return: { data: "ok" } },
    ]);
    const settled = requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog).then(
      (r) => r,
      (e) => e
    );
    // Negative retry-after is ignored; the reset is ~2s out, so no retry yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(req.count()).toBe(1);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toEqual({ data: "ok" });
    expect(req.count()).toBe(2);
  });

  it("does not retry a plain 403 (permission denied, no rate-limit headers)", async () => {
    const req = mockRequest([{ throw: ghError(403) }]);
    await expect(requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog)).rejects.toMatchObject({
      status: 403,
    });
    expect(req.count()).toBe(1);
  });

  it("does not retry a 404", async () => {
    const req = mockRequest([{ throw: ghError(404) }]);
    await expect(requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog)).rejects.toMatchObject({
      status: 404,
    });
    expect(req.count()).toBe(1);
  });

  it("does not retry once the AbortSignal has fired (cancelled review)", async () => {
    const controller = new AbortController();
    // Fails first with a retryable error; aborting before it resolves must
    // surface the error immediately rather than entering another attempt.
    const req = mockRequest([{ throw: ghError(429, { "retry-after": "30" }) }, { return: { data: "ok" } }]);
    const p = requestWithRetry(req, { method: "GET", url: "/x" }, controller.signal, quietLog);
    controller.abort();
    await expect(p).rejects.toMatchObject({ status: 429 });
    expect(req.count()).toBe(1);
  });

  it("stops waiting and bails when aborted mid-backoff", async () => {
    const controller = new AbortController();
    const req = mockRequest([{ throw: ghError(503) }, { return: { data: "ok" } }]);
    const p = requestWithRetry(req, { method: "GET", url: "/x" }, controller.signal, quietLog);
    // First attempt fails (503) and enters the ~1s backoff; abort during it.
    await Promise.resolve();
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ status: 503 });
    expect(req.count()).toBe(1);
  });

  it("forwards the AbortSignal into the underlying request options", async () => {
    const controller = new AbortController();
    let seen: any;
    const req = Object.assign(
      async (options: any) => {
        seen = options;
        return { data: "ok" };
      },
      { count: () => 1 }
    );
    await requestWithRetry(req, { method: "GET", url: "/x" }, controller.signal, quietLog);
    expect(seen.request?.signal).toBe(controller.signal);
  });

  it("preserves caller-supplied options.request when forwarding the signal", async () => {
    const controller = new AbortController();
    let seen: any;
    const req = async (options: any) => {
      seen = options;
      return { data: "ok" };
    };
    await requestWithRetry(
      req,
      { method: "GET", url: "/x", request: { timeout: 1234 } },
      controller.signal,
      quietLog
    );
    expect(seen.request?.signal).toBe(controller.signal);
    expect(seen.request?.timeout).toBe(1234);
  });

  it("does not add a request.signal when no signal is supplied", async () => {
    let seen: any;
    const req = async (options: any) => {
      seen = options;
      return { data: "ok" };
    };
    await requestWithRetry(req, { method: "GET", url: "/x" }, undefined, quietLog);
    expect(seen.request?.signal).toBeUndefined();
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const req = mockRequest([{ return: { data: "ok" } }]);
    await expect(requestWithRetry(req, { method: "GET", url: "/x" }, controller.signal, quietLog)).rejects.toThrow();
    expect(req.count()).toBe(0);
  });
});
