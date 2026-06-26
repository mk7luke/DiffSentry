import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "../../src/webhook/signature.js";

// GitHub webhook signature verification — the timing-safe path that guards
// every real delivery (src/server.ts) and the diagnostics self-test.
describe("signWebhookPayload", () => {
  const secret = "it's-a-secret-to-everybody";
  const payload = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 42 });

  it("matches GitHub's sha256= HMAC-SHA256 vector", () => {
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    expect(signWebhookPayload(secret, payload)).toBe(expected);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "it's-a-secret-to-everybody";
  const payload = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 42 });
  const valid = signWebhookPayload(secret, payload);

  it("accepts a signature it just produced", () => {
    expect(verifyWebhookSignature(secret, payload, valid)).toBe(true);
  });

  it("accepts an upper-cased hex digest (byte comparison, not ASCII)", () => {
    const upper = "sha256=" + valid.slice("sha256=".length).toUpperCase();
    expect(verifyWebhookSignature(secret, payload, upper)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    expect(verifyWebhookSignature(secret, payload + " ", valid)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyWebhookSignature(secret, payload, signWebhookPayload(secret + "x", payload))).toBe(false);
  });

  it("rejects an empty secret", () => {
    expect(verifyWebhookSignature("", payload, valid)).toBe(false);
  });

  describe("missing / malformed headers (returns false, never throws)", () => {
    it("rejects undefined", () => {
      expect(verifyWebhookSignature(secret, payload, undefined)).toBe(false);
    });

    it("rejects null", () => {
      expect(verifyWebhookSignature(secret, payload, null)).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(verifyWebhookSignature(secret, payload, "")).toBe(false);
    });

    it("rejects a value without the sha256= prefix", () => {
      const bareHex = valid.slice("sha256=".length);
      expect(verifyWebhookSignature(secret, payload, bareHex)).toBe(false);
    });

    it("rejects a wrong scheme prefix (sha1=)", () => {
      expect(verifyWebhookSignature(secret, payload, "sha1=" + valid.slice("sha256=".length))).toBe(false);
    });
  });

  describe("wrong-length / non-hex digests (guarded before timingSafeEqual)", () => {
    it("rejects a too-short digest", () => {
      expect(verifyWebhookSignature(secret, payload, "sha256=abc")).toBe(false);
    });

    it("rejects a too-long digest", () => {
      expect(verifyWebhookSignature(secret, payload, "sha256=" + "a".repeat(65))).toBe(false);
    });

    it("rejects an odd-length digest", () => {
      expect(verifyWebhookSignature(secret, payload, "sha256=" + "a".repeat(63))).toBe(false);
    });

    it("rejects a correct-length but non-hex digest", () => {
      expect(verifyWebhookSignature(secret, payload, "sha256=" + "z".repeat(64))).toBe(false);
    });
  });
});
