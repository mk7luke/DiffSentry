/**
 * Smoke-test command-center DAO helpers against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-dao.ts  (or: npm run smoke:dao)
 *
 * Focused on triageFinding's update semantics: a multi-field call updates the
 * target row, an identical repeat is a no-op (returns false, triaged_at not
 * re-stamped), a changed value updates again, and degenerate calls return false.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-dao-smoke-"));
  const tmpDb = path.join(tmpDir, "diffsentry.db");
  process.env.DB_PATH = tmpDb;

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { triageFinding, saveWalkthroughState, getWalkthroughState } = await import("../src/storage/dao.js");
  type WalkthroughState = import("../src/walkthrough-state.js").WalkthroughState;

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  try {
    const reviewId = Number(
      db
        .prepare(`INSERT INTO reviews (owner, repo, number, sha, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run("acme", "widgets", 1, "deadbeef", "2026-01-01T00:00:00.000Z").lastInsertRowid,
    );
    const findingId = Number(
      db
        .prepare(`INSERT INTO findings (review_id, path, severity, title) VALUES (?, ?, ?, ?)`)
        .run(reviewId, "src/x.ts", "major", "A finding").lastInsertRowid,
    );

    // Multiple supplied fields → row changes.
    const r1 = triageFinding({ findingId, accepted: true, triagedBy: "Alice", triageNote: "looks fine" });
    assert.equal(r1, true, "first multi-field triage should update the row");
    const row1 = db
      .prepare(`SELECT accepted, triaged_by, triage_note, triaged_at FROM findings WHERE id = ?`)
      .get(findingId) as { accepted: number; triaged_by: string; triage_note: string; triaged_at: string };
    assert.equal(row1.accepted, 1, "accepted persisted");
    assert.equal(row1.triaged_by, "Alice", "triaged_by persisted as-is");
    assert.equal(row1.triage_note, "looks fine", "triage_note persisted");
    assert.ok(row1.triaged_at, "triaged_at stamped");
    const firstStamp = row1.triaged_at;

    // Identical repeat → no-op, triaged_at NOT re-stamped.
    const r2 = triageFinding({ findingId, accepted: true, triagedBy: "Alice", triageNote: "looks fine" });
    assert.equal(r2, false, "identical repeat should not update");
    const row2 = db.prepare(`SELECT triaged_at FROM findings WHERE id = ?`).get(findingId) as { triaged_at: string };
    assert.equal(row2.triaged_at, firstStamp, "triaged_at must not be re-stamped on a no-op repeat");

    // A changed value → updates again.
    const r3 = triageFinding({ findingId, accepted: false, triagedBy: "Alice", triageNote: "looks fine" });
    assert.equal(r3, true, "a changed field should update");
    assert.equal(
      (db.prepare(`SELECT accepted FROM findings WHERE id = ?`).get(findingId) as { accepted: number }).accepted,
      0,
      "accepted flipped to 0",
    );

    // No triage field → no-op.
    assert.equal(triageFinding({ findingId }), false, "a call with only findingId is a no-op");

    // Non-existent finding → false.
    assert.equal(triageFinding({ findingId: 9_999_999, accepted: true }), false, "missing finding returns false");

    console.log("ok  triageFinding: multi-field update, idempotent repeat, change detection, no-op guards");

    // ── Walkthrough / incremental-review state (schema v6) ──────────────
    // Missing row → null (reviewer then falls back to the embedded comment blob).
    assert.equal(getWalkthroughState("acme", "widgets", 7), null, "missing walkthrough state reads null");

    const state: WalkthroughState = {
      v: 1,
      lastReviewedSha: "cafe1234",
      fileShas: { "src/a.ts": "h1", "src/b.ts": "h2" },
      postedFingerprints: ["fp-a", "fp-b"],
      filesProcessed: ["src/a.ts"],
      filesSkippedSimilar: ["src/b.ts"],
      filesSkippedTrivial: [],
      updatedAt: "2026-01-02T00:00:00.000Z",
      riskHistory: [10, 20, 30],
    };
    assert.equal(saveWalkthroughState("acme", "widgets", 7, state), true, "saveWalkthroughState writes a row");

    const loaded = getWalkthroughState("acme", "widgets", 7);
    assert.ok(loaded, "walkthrough state round-trips");
    assert.equal(loaded!.lastReviewedSha, "cafe1234", "lastReviewedSha persisted");
    assert.deepEqual(loaded!.fileShas, state.fileShas, "fileShas persisted in full (the DB is the source of truth)");
    assert.deepEqual(loaded!.postedFingerprints, state.postedFingerprints, "postedFingerprints persisted in full");

    // Upsert overwrites the same (owner, repo, number) key in place.
    const next: WalkthroughState = { ...state, lastReviewedSha: "beef5678", riskHistory: [10, 20, 30, 40] };
    assert.equal(saveWalkthroughState("acme", "widgets", 7, next), true, "second save upserts");
    const reloaded = getWalkthroughState("acme", "widgets", 7);
    assert.equal(reloaded!.lastReviewedSha, "beef5678", "upsert replaces lastReviewedSha");
    assert.deepEqual(reloaded!.riskHistory, [10, 20, 30, 40], "upsert replaces riskHistory");
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM walkthrough_state WHERE owner=? AND repo=? AND number=?`).get("acme", "widgets", 7) as { n: number }).n,
      1,
      "upsert keeps exactly one row per PR",
    );

    console.log("ok  walkthroughState: missing→null, round-trip (full), upsert-in-place");
  } finally {
    closeDatabase();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\nDAO smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
