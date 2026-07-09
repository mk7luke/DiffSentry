import { describe, it, expect } from "vitest";
import { isTransientError } from "../../src/ai/transient.js";
import { AiTimeoutError } from "../../src/ai/timeout.js";

describe("isTransientError", () => {
  it("treats an AiTimeoutError as transient", () => {
    expect(isTransientError(new AiTimeoutError("openai-compatible", "review", 20000))).toBe(true);
  });

  it("treats transient network codes as transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("treats HTTP 5xx and 429 as transient", () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
  });

  it("does NOT treat auth/4xx as transient", () => {
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 403 })).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });

  it("treats AbortError / TimeoutError names as transient", () => {
    expect(isTransientError({ name: "AbortError" })).toBe(true);
    expect(isTransientError({ name: "TimeoutError" })).toBe(true);
  });

  it("matches transient message hints", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("service unavailable"))).toBe(true);
  });

  it("treats an ordinary error as non-transient", () => {
    expect(isTransientError(new Error("bad request: invalid model"))).toBe(false);
  });
});
