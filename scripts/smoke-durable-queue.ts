/**
 * Smoke-test the durable review queue + webhook idempotency + bounded retry /
 * dead-letter, against a temp SQLite DB. Run: npx tsx scripts/smoke-durable-queue.ts
 *
 * Asserts:
 *   - migration 5 created review_jobs + processed_deliveries
 *   - claimWebhookDelivery is idempotent: first claim wins, a redelivery is rejected
 *   - a successful review job leaves NO durable row (recovery won't re-run it)
 *   - a non-transient failure fails fast (one attempt) and the durable row is `failed`
 *   - a transient failure is retried up to the cap, then dead-lettered: the durable
 *     row is `dead_letter`, the board card flips to dead_letter, and a
 *     review.dead_letter event lands
 *   - boot recovery re-enqueues a row left `running` by a crash, with its stored args
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedProcessingLeaseForTest, seedRawLeaseForTest } from "./lib/durable-test-helpers.js";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-durable-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  // Make retries fast + deterministic: 2 attempts total, ~1ms backoff.
  process.env.REVIEW_RETRY_MAX_ATTEMPTS = "2";
  process.env.REVIEW_RETRY_BASE_MS = "1";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const {
    claimWebhookDelivery,
    completeWebhookDelivery,
    releaseWebhookDelivery,
    listInFlightReviewJobs,
    upsertReviewJob,
  } = await import("../src/storage/dao.js");
  const { runReviewJob, recoverInFlightJobs, isTransientError } = await import("../src/realtime/jobs.js");
  const { reviewQueue } = await import("../src/realtime/queue.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  // Hold the event loop open for the duration of the test: runReviewJob's retry
  // backoff uses an UNREF'd timer (by design — a pending retry must never keep a
  // shutting-down process alive), so without a ref here Node could exit during a
  // backoff before the timer fires. Production keeps the loop alive via the HTTP
  // server; the smoke test stands in with one ref'd timer, cleared in finally.
  // A single setTimeout (not an interval) is the right primitive — the test
  // finishes well within this window and clears it on the way out.
  const keepAlive = setTimeout(() => {}, 120_000);

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  interface Call {
    args: [number, string, string, number, string];
  }
  const jobRow = (owner: string, repo: string, num: number) =>
    db.prepare(`SELECT state, last_error, attempts, installation_id, mode FROM review_jobs WHERE key = ?`).get(
      `${owner}/${repo}#${num}`,
    ) as { state: string; last_error: string | null; attempts: number; installation_id: number; mode: string } | undefined;

  try {
    // ── migration 5 ─────────────────────────────────────────────────────
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    ok("migration 5 created review_jobs + processed_deliveries", tables.has("review_jobs") && tables.has("processed_deliveries"));

    // ── idempotency ─────────────────────────────────────────────────────
    const STALE_AGE_MS = 60 * 60 * 1000; // 1h — well past the default lease TTL
    const c1 = claimWebhookDelivery("gh-1");
    ok("first claim of a delivery id wins (processing lease)", c1 !== null);
    ok("a fresh in-flight redelivery is rejected", claimWebhookDelivery("gh-1") === null);
    const c2 = claimWebhookDelivery("gh-2");
    ok("a different delivery id is claimable", c2 !== null);
    // Release (the failure finalizer) re-opens the id so a redelivery is
    // processed instead of suppressed as a phantom duplicate. It reports whether
    // the owned row was actually freed.
    ok("release of an owned lease reports success (true)", releaseWebhookDelivery(c2!) === true);
    ok("released delivery id is claimable again", claimWebhookDelivery("gh-2") !== null);
    // Complete (the success finalizer): a completed delivery is a true duplicate.
    ok("complete of an owned lease reports success (true)", completeWebhookDelivery(c1!) === true);
    ok("a completed delivery rejects redelivery (true duplicate)", claimWebhookDelivery("gh-1") === null);
    // Crash safety: a `processing` lease left behind by a crash is reclaimable
    // once stale. The dao test helper seeds a back-dated lease (no inline SQL).
    seedProcessingLeaseForTest(db, "gh-crash", STALE_AGE_MS);
    ok("a stale processing lease (crashed mid-flight) is reclaimable", claimWebhookDelivery("gh-crash") !== null);
    ok("the reclaimed lease is fresh, so an immediate redelivery is rejected", claimWebhookDelivery("gh-crash") === null);
    // A corrupt/unparsable lease stamp must be treated as stale (reclaimable),
    // never as a fresh lease that would permanently suppress redeliveries.
    seedRawLeaseForTest(db, "gh-corrupt", "not-a-timestamp");
    ok("an unparsable lease stamp is reclaimable (not treated as fresh)", claimWebhookDelivery("gh-corrupt") !== null);

    // ── finalizer ownership: a reclaim rotates the token, so the crashed
    //    claim's late finalizer can't touch the new owner's row ──────────────
    const staleToken = seedProcessingLeaseForTest(db, "gh-owned", STALE_AGE_MS);
    const reclaimed = claimWebhookDelivery("gh-owned"); // reclaims → fresh token
    ok("stale lease reclaimed by a new owner", reclaimed !== null && reclaimed!.token !== staleToken);
    // The crashed (old-token) owner tries to release — must NOT delete the row,
    // and must report the no-op (false) so the handler can surface it.
    ok("old owner's release reports no-op (false)", releaseWebhookDelivery({ deliveryId: "gh-owned", token: staleToken }) === false);
    ok("old owner's release does NOT free the new owner's lease", claimWebhookDelivery("gh-owned") === null);
    // The new owner finalizes its own lease normally.
    ok("new owner completes its own lease (true)", completeWebhookDelivery(reclaimed!) === true);
    ok("new owner's completed lease rejects redelivery", claimWebhookDelivery("gh-owned") === null);

    // ── transient classification ────────────────────────────────────────
    ok("ETIMEDOUT is transient", isTransientError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })));
    ok("HTTP 503 is transient", isTransientError(Object.assign(new Error("x"), { status: 503 })));
    ok("HTTP 429 is transient", isTransientError(Object.assign(new Error("x"), { status: 429 })));
    ok("'socket hang up' is transient", isTransientError(new Error("socket hang up")));
    ok("HTTP 400 is NOT transient", isTransientError(Object.assign(new Error("bad"), { status: 400 })) === false);

    // ── success path: no durable row left behind ────────────────────────
    const okCalls: Call[] = [];
    const okReviewer = {
      handlePullRequest: (...args: Call["args"]) => {
        okCalls.push({ args });
        return Promise.resolve();
      },
    };
    await runReviewJob({ reviewer: okReviewer, installationId: 11, owner: "acme", repo: "web", number: 1, mode: "full" });
    ok("success → handlePullRequest called once", okCalls.length === 1 && okCalls[0].args[3] === 1);
    ok("success → no durable row remains (won't re-run on boot)", jobRow("acme", "web", 1) === undefined);

    // ── non-transient failure fails fast ────────────────────────────────
    let permCalls = 0;
    const permReviewer = {
      handlePullRequest: () => {
        permCalls++;
        return Promise.reject(Object.assign(new Error("bad config"), { status: 400 }));
      },
    };
    await runReviewJob({ reviewer: permReviewer, installationId: 12, owner: "acme", repo: "web", number: 2, mode: "full" });
    ok("non-transient → only one attempt (fail fast)", permCalls === 1);
    ok("non-transient → durable row is failed", jobRow("acme", "web", 2)?.state === "failed");

    // ── transient failure → bounded retry → dead-letter ─────────────────
    // The fake mimics the real reviewer: it enqueues a board card and fails it in
    // a finally before throwing, so the board lifecycle matches production.
    let transientCalls = 0;
    const transientReviewer = {
      handlePullRequest: async (i: number, o: string, r: string, n: number, m: "full" | "incremental") => {
        transientCalls++;
        const h = reviewQueue.enqueue(o, r, n, m);
        h.start("reviewing");
        try {
          throw new Error("socket hang up");
        } finally {
          h.fail("socket hang up");
        }
      },
    };
    await runReviewJob({ reviewer: transientReviewer, installationId: 13, owner: "acme", repo: "web", number: 3, mode: "incremental" });
    ok("transient → retried up to the cap (2 attempts)", transientCalls === 2);
    ok("transient exhausted → durable row is dead_letter", jobRow("acme", "web", 3)?.state === "dead_letter");
    const card = reviewQueue.snapshot().find((e) => e.number === 3);
    ok("transient exhausted → board card is dead_letter", card?.state === "dead_letter" && card?.attempt === 2);
    const dlEvents = db.prepare(`SELECT kind FROM events WHERE owner=? AND repo=? AND number=?`).all("acme", "web", 3) as { kind: string }[];
    ok("dead-letter recorded a review.dead_letter event", dlEvents.some((e) => e.kind === "review.dead_letter"));

    // ── boot recovery re-enqueues an in-flight (crashed) job ────────────
    // Simulate a crash: a 'running' row persisted, but the process died before a
    // terminal write. listInFlightReviewJobs must surface it.
    upsertReviewJob({
      runId: "crashed-run",
      owner: "acme",
      repo: "api",
      number: 42,
      mode: "full",
      installationId: 99,
      state: "running",
      attempts: 1,
    });
    ok("crashed in-flight job is listed for recovery", listInFlightReviewJobs().some((j) => j.number === 42 && j.installation_id === 99));

    const recCalls: Call[] = [];
    const recReviewer = {
      handlePullRequest: (...args: Call["args"]) => {
        recCalls.push({ args });
        return Promise.resolve();
      },
    };
    const recovered = recoverInFlightJobs(recReviewer);
    ok("recoverInFlightJobs reports the recovered count", recovered === 1);
    // The recovered job runs fire-and-forget; give it a tick to invoke + finalize.
    await new Promise((r) => setTimeout(r, 30));
    ok(
      "recovery re-invoked handlePullRequest with the stored args",
      recCalls.length === 1 &&
        recCalls[0].args[0] === 99 &&
        recCalls[0].args[1] === "acme" &&
        recCalls[0].args[2] === "api" &&
        recCalls[0].args[3] === 42 &&
        recCalls[0].args[4] === "full",
    );
    ok("recovered job completed → durable row cleared", jobRow("acme", "api", 42) === undefined);

    console.log("\nall durable-queue smoke checks passed ✓");
  } finally {
    clearTimeout(keepAlive);
    closeDatabase();
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      // best effort
    }
    for (const k of ["DB_PATH", "REVIEW_RETRY_MAX_ATTEMPTS", "REVIEW_RETRY_BASE_MS"]) delete process.env[k];
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
