/**
 * Smoke-test the shared webhook signature verifier used by BOTH the live
 * /webhook route (src/server.ts) and the diagnostics self-test. Run:
 *   npx tsx scripts/smoke-signature.ts
 *
 * Locks the GitHub `sha256=` HMAC contract against a fixed known vector so the
 * production verification path can't silently drift.
 */
import crypto from "node:crypto";

async function main() {
  const { signWebhookPayload, verifyWebhookSignature } = await import("../src/webhook/signature.js");

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  const secret = "it's-a-secret-to-everybody";
  const payload = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 42 });

  // Known vector: the signer must match a hand-computed HMAC-SHA256.
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  ok("signWebhookPayload matches GitHub's sha256= HMAC", signWebhookPayload(secret, payload) === expected);

  // A signature produced for the payload verifies.
  ok("valid signature verifies", verifyWebhookSignature(secret, payload, expected) === true);

  // Hex is compared as bytes, so an upper-cased digest still verifies.
  ok(
    "uppercase hex digest verifies (case-insensitive)",
    verifyWebhookSignature(secret, payload, "sha256=" + expected.slice("sha256=".length).toUpperCase()) === true,
  );

  // Tampered payload → reject.
  ok(
    "tampered payload rejected",
    verifyWebhookSignature(secret, payload + " ", expected) === false,
  );

  // Wrong secret → reject.
  ok(
    "wrong-secret signature rejected",
    verifyWebhookSignature(secret, payload, signWebhookPayload(secret + "x", payload)) === false,
  );

  // Malformed / missing signatures → reject (never throw).
  ok("missing sha256= prefix rejected", verifyWebhookSignature(secret, payload, "deadbeef") === false);
  ok("empty signature rejected", verifyWebhookSignature(secret, payload, "") === false);
  ok("null signature rejected", verifyWebhookSignature(secret, payload, null) === false);
  ok("empty secret rejected", verifyWebhookSignature("", payload, expected) === false);
  ok(
    "wrong-length sha256= rejected (no throw)",
    verifyWebhookSignature(secret, payload, "sha256=abc") === false,
  );

  console.log("\nall signature smoke checks passed ✓");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
