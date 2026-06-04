/**
 * Smoke-test AI cost instrumentation against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-cost.ts  (or: npm run smoke:cost)
 *
 * Exercises the full path the acceptance criterion cares about, minus the live
 * GitHub/AI calls:
 *   1. pricing — exact + prefix model match, unknown model → 0 cost
 *   2. review path — usage recorded under a cost context, buffered, then
 *      flushed with the review_id stamped (mirrors reviewer.handlePullRequest)
 *   3. the /cost query rollups (totals, by-model, by-repo, by-day, MTD)
 *   4. budgets — crossing a ceiling emits exactly one budget.exceeded event
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-cost-smoke-"));
  process.env.DB_PATH = path.join(tmpDir, "diffsentry.db");
  delete process.env.AI_MODEL_PRICES; // use the built-in table

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { computeCostUsd, priceForModel } = await import("../src/ai/pricing.js");
  const { runWithCostContext, recordAiUsage, setCostReviewId, flushCostEvents, resetBudgetAlerts, BUDGET_KEY } =
    await import("../src/ai/cost.js");
  const { upsertSettingOverride } = await import("../src/storage/dao.js");
  const { getCostTotals, getCostByGroup, getCostDailyByModel, getMonthToDateCost } = await import(
    "../src/dashboard/queries.js"
  );
  const { bus } = await import("../src/realtime/bus.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const monthStart = (() => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString();
  })();

  try {
    // ── 1. Pricing ──────────────────────────────────────────────────
    assert.ok(priceForModel("claude-sonnet-4-20250514"), "snapshot id resolves via prefix");
    // claude-sonnet-4 = $3/1M in, $15/1M out → 1M each = $18.
    assert.equal(computeCostUsd("claude-sonnet-4-20250514", 1_000_000, 1_000_000), 18, "prefix price math");
    assert.equal(computeCostUsd("gpt-4o-mini", 1_000_000, 0), 0.15, "gpt-4o-mini wins over gpt-4o prefix");
    assert.equal(computeCostUsd("totally-unknown-model", 1000, 1000), 0, "unknown model → 0 cost");
    console.log("ok  pricing: exact/prefix match + unknown → 0");

    // ── 2. Review path: buffered usage, flushed with review_id ───────
    const reviewId = Number(
      db
        .prepare(`INSERT INTO reviews (owner, repo, number, sha, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run("acme", "widgets", 7, "cafe", new Date().toISOString()).lastInsertRowid,
    );
    runWithCostContext({ owner: "acme", repo: "widgets", number: 7, kind: "review", reviewId: null, pending: [] }, () => {
      // Two AI calls during the "review" — review + walkthrough.
      recordAiUsage({ provider: "anthropic", model: "claude-sonnet-4-20250514", inputTokens: 10_000, outputTokens: 2_000, fallbackKind: "review" });
      recordAiUsage({ provider: "anthropic", model: "claude-sonnet-4-20250514", inputTokens: 5_000, outputTokens: 1_000, fallbackKind: "walkthrough" });
      // Nothing persisted yet — still buffered until the review_id is known.
      assert.equal(getCostTotals({}).events, 0, "usage stays buffered before flush");
      setCostReviewId(reviewId);
    });

    const totals = getCostTotals({});
    assert.equal(totals.events, 2, "both calls persisted after flush");
    assert.equal(totals.input_tokens, 15_000, "input tokens summed");
    assert.equal(totals.output_tokens, 3_000, "output tokens summed");
    assert.ok(totals.cost_usd > 0, "cost computed");

    const stamped = db
      .prepare(`SELECT COUNT(*) AS n FROM cost_events WHERE review_id = ? AND kind = 'review'`)
      .get(reviewId) as { n: number };
    assert.equal(stamped.n, 2, "both events stamped with review_id and kind=review (context wins over fallback)");
    console.log("ok  review path: buffered → flushed with review_id, kind=review");

    // ── 3. Query rollups ────────────────────────────────────────────
    const byModel = getCostByGroup({ group: "model" });
    assert.equal(byModel.length, 1, "one model");
    assert.equal(byModel[0].key, "claude-sonnet-4-20250514", "model key");
    const byRepo = getCostByGroup({ group: "repo" });
    assert.equal(byRepo[0].key, "acme/widgets", "repo key owner/repo");
    const byDay = getCostDailyByModel({});
    assert.ok(byDay.length >= 1, "at least one day bucket");
    assert.ok(getMonthToDateCost(null, null, monthStart) > 0, "MTD global > 0");
    console.log("ok  rollups: by-model, by-repo, by-day, month-to-date");

    // ── 4. Budgets: crossing the ceiling alerts exactly once ─────────
    // The alert also publishes on the in-process bus (consumed by SSE in the
    // running server); we assert on the durable DB side-effects here because
    // they share the one DB regardless of module-loading quirks.
    const alerts: Array<{ scope: string; spentUsd: number; budgetUsd: number }> = [];
    const unsub = bus.subscribe((env) => {
      if (env.topic === "budget.exceeded") alerts.push(env.payload as (typeof alerts)[number]);
    });
    // Set a ceiling already below the spend recorded above, then clear the
    // in-memory dedupe so the next write evaluates fresh.
    upsertSettingOverride({ scope: "global", key: BUDGET_KEY, value: 0.01, updatedBy: "tester" });
    resetBudgetAlerts();
    // One more chargeable call (no context → immediate write) trips the check.
    runWithCostContext({ owner: "acme", repo: "widgets", number: 7, kind: "chat" }, () => {
      recordAiUsage({ provider: "anthropic", model: "claude-sonnet-4-20250514", inputTokens: 1_000, outputTokens: 1_000, fallbackKind: "chat" });
    });
    // And another — must NOT double-alert for the same scope+month.
    runWithCostContext({ owner: "acme", repo: "widgets", number: 7, kind: "chat" }, () => {
      recordAiUsage({ provider: "anthropic", model: "claude-sonnet-4-20250514", inputTokens: 1_000, outputTokens: 1_000, fallbackKind: "chat" });
    });
    flushCostEvents();
    unsub();

    const eventN = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'budget.exceeded'`)
      .get() as { n: number };
    assert.equal(eventN.n, 1, "budget.exceeded recorded once in events (single alert per scope/month)");
    const auditRow = db
      .prepare(`SELECT target_ref, result FROM audit_log WHERE action = 'budget.exceeded'`)
      .get() as { target_ref: string; result: string } | undefined;
    assert.ok(auditRow, "budget alert recorded in audit_log");
    assert.equal(auditRow?.target_ref, "global", "audit target is the scope");
    assert.equal(auditRow?.result, "alert", "audit result tagged 'alert'");
    // Bus delivery is best-effort here (a duplicate bus module instance can be
    // loaded under this script's path); when it is in play, assert its shape.
    if (alerts.length > 0) {
      assert.equal(alerts[0].scope, "global", "bus alert scope");
      assert.ok(alerts[0].spentUsd > alerts[0].budgetUsd, "bus alert reports spend over budget");
    }
    console.log("ok  budgets: single alert on crossing + audit/event rows");
  } finally {
    closeDatabase();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\nCost smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
