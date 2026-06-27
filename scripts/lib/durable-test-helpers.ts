import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

// ─────────────────────────────────────────────────────────────────────────────
// Test-only helpers for the durable-queue / webhook-idempotency smoke tests.
//
// These live under scripts/ (NOT the production src/ build — tsconfig includes
// only src/**), so they never reach the shipped bundle, and no runtime module
// imports them. They exist so smoke tests can set up otherwise-hard-to-reach
// states (e.g. a back-dated lease) using named symbols instead of hand-writing
// the processed_deliveries schema inline in the test body.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed a `processing` webhook-delivery lease for `deliveryId`, back-dated by
 * `ageMs`, so a smoke test can exercise stale-lease reclamation and finalizer
 * ownership. Returns the seeded claim token (the value a "crashed" owner would
 * still hold). Mirrors the columns claimWebhookDelivery writes.
 */
export function seedProcessingLeaseForTest(db: Database, deliveryId: string, ageMs: number): string {
  const token = randomUUID();
  const ts = new Date(Date.now() - Math.max(0, ageMs)).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO processed_deliveries (delivery_id, status, ts, token) VALUES (?, 'processing', ?, ?)`,
  ).run(deliveryId, ts, token);
  return token;
}
