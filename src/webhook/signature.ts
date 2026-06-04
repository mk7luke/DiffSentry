import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub webhook signature — the single source of truth shared by the live
// /webhook receiver (src/server.ts) and the diagnostics self-test
// (src/api/diagnostics.ts), so the self-test exercises the exact code path that
// guards real deliveries.
//
// GitHub signs each delivery as `sha256=<hex HMAC-SHA256(secret, rawBody)>` in
// the X-Hub-Signature-256 header. We recompute that and timing-safe compare.
// Implemented with node:crypto (not @octokit/webhooks) so it's importable from
// the CommonJS API layer without the ESM-only resolution friction.
// ─────────────────────────────────────────────────────────────────────────────

/** The `sha256=…` signature GitHub would send for `payload` under `secret`. */
export function signWebhookPayload(secret: string, payload: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Verify a GitHub `sha256=…` signature against the raw payload string. Returns
 * `false` (never throws) for a missing, malformed, wrong-length, or mismatched
 * signature — so callers can read the boolean as "trust this delivery?".
 */
export function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string | undefined | null,
): boolean {
  if (!secret || typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const providedHex = signature.slice("sha256=".length);
  // Validate the digest shape before Buffer.from(..., "hex"), which otherwise
  // silently drops odd/invalid nibbles and would compare a short buffer.
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;
  // Compare the raw 32-byte digests (case-insensitive, unlike an ASCII compare).
  const provided = Buffer.from(providedHex, "hex");
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
