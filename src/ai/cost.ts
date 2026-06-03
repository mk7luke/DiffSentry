import { AsyncLocalStorage } from "node:async_hooks";
import { computeCostUsd } from "./pricing.js";
import { recordCostEvent, recordEvent, getSettingOverride, insertAuditLog } from "../storage/dao.js";
import { getMonthToDateCost } from "../dashboard/queries.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// AI spend instrumentation.
//
// Every provider call funnels its token usage through `recordAiUsage`, which
// computes a dollar cost from the price table and writes a `cost_events` row.
// The owner/repo/number/review_id/kind tags come from an AsyncLocalStorage
// "cost context" that the engine establishes around a unit of work (a review, a
// chat command, an issue summary). Using ALS keeps the AIProvider interface
// unchanged and is concurrency-safe: two PRs reviewed at the same time each run
// in their own async context, so their usage never cross-attributes.
//
// During a review the review_id isn't known until the review row is inserted —
// after the AI calls have already happened. So the review path buffers its
// usage (ctx.pending) and flushes it once `setCostReviewId` stamps the id. Other
// paths (chat/issue/finishing-touch) have no review row and write immediately.
//
// All writes are best-effort: nothing here ever throws into a provider call.
// ─────────────────────────────────────────────────────────────────────────────

/** The settings_overrides key a monthly budget is stored under, per scope. */
export const BUDGET_KEY = "budget.monthly_usd";

/** A usage record captured from one provider call, before it is persisted. */
export interface PendingCostEvent {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  kind: string | null;
}

/** Ambient attribution for AI calls made within a unit of engine work. */
export interface CostContext {
  owner?: string | null;
  repo?: string | null;
  number?: number | null;
  reviewId?: number | null;
  /** review | chat | finishing-touch | issue | summary | … */
  kind?: string | null;
  /**
   * When present, captured usage is buffered here instead of written
   * immediately — so it can be stamped with the review_id once that exists.
   * The review path seeds this with `[]`; other paths leave it undefined.
   */
  pending?: PendingCostEvent[];
}

const storage = new AsyncLocalStorage<CostContext>();

/**
 * Run `fn` with an active cost context. Uses `storage.run`, which forks a fresh
 * isolated context for the callback and its descendants and restores the prior
 * store afterwards — so concurrent units of work never see each other's context.
 * (We deliberately avoid `AsyncLocalStorage.enterWith`, which mutates the
 * current context in place and can leak/cross-attribute under concurrency.)
 */
export function runWithCostContext<T>(ctx: CostContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active cost context, if any. */
export function getCostContext(): CostContext | undefined {
  return storage.getStore();
}

/** Stamp the review_id on the active context and flush any buffered usage. */
export function setCostReviewId(reviewId: number | null): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.reviewId = reviewId;
  flushCostEvents();
}

/**
 * Write any buffered usage for the active context, stamping the current
 * review_id, then clear the buffer. Safe to call when there is no context or
 * nothing buffered. Switches the context to immediate-write mode afterwards so
 * later calls in the same scope persist as they happen.
 */
export function flushCostEvents(): void {
  const ctx = storage.getStore();
  if (!ctx || !ctx.pending || ctx.pending.length === 0) {
    if (ctx) ctx.pending = undefined;
    return;
  }
  const buffered = ctx.pending;
  ctx.pending = undefined;
  for (const ev of buffered) {
    // Each write is isolated: a failure on one event must not abort the rest,
    // and flushCostEvents must never throw — it runs in a reviewer finally block.
    try {
      writeCostEvent(ctx, ev);
    } catch (err) {
      logger.debug({ err }, "flushCostEvents: writeCostEvent failed");
    }
  }
}

/**
 * Capture usage from one provider call. Computes the dollar cost, tags it with
 * the active context (falling back to `fallbackKind` when no context kind is
 * set), and either buffers or persists it. Never throws.
 */
export function recordAiUsage(opts: {
  provider: string;
  model: string | null;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  /** Kind to use when the active context didn't set one (or there's no context). */
  fallbackKind: string;
}): void {
  try {
    const ctx = storage.getStore();
    const inputTokens = toFiniteOrNull(opts.inputTokens);
    const outputTokens = toFiniteOrNull(opts.outputTokens);
    const costUsd = computeCostUsd(opts.model, inputTokens, outputTokens);
    const event: PendingCostEvent = {
      provider: opts.provider,
      model: opts.model,
      inputTokens,
      outputTokens,
      costUsd,
      kind: ctx?.kind ?? opts.fallbackKind,
    };
    if (ctx?.pending) {
      ctx.pending.push(event);
      return;
    }
    writeCostEvent(ctx, event);
  } catch (err) {
    logger.debug({ err }, "recordAiUsage failed");
  }
}

function toFiniteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Persist one event (best-effort) and run the budget check for its scope(s). */
function writeCostEvent(ctx: CostContext | undefined, ev: PendingCostEvent): void {
  const owner = ctx?.owner ?? null;
  const repo = ctx?.repo ?? null;
  const number = ctx?.number ?? null;
  const reviewId = ctx?.reviewId ?? null;
  recordCostEvent({
    owner,
    repo,
    number,
    reviewId,
    provider: ev.provider,
    model: ev.model,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    costUsd: ev.costUsd,
    kind: ev.kind,
  });
  // Only bother with budget evaluation when this call actually cost something.
  if (ev.costUsd > 0) {
    checkBudgets(owner, repo);
  }
}

// ── Budgets & alerting (Pillar D) ────────────────────────────────────────────
//
// A budget is a monthly USD ceiling stored in settings_overrides under
// BUDGET_KEY, scoped 'global' or 'owner/repo'. After a cost write we compare the
// month-to-date spend for each configured scope against its ceiling and, on the
// first crossing within a given month, emit a `budget.exceeded` event on the bus
// (for the realtime dashboard / notifications), persist an `events` row, and
// write an audit_log entry. The in-memory dedupe keeps it to one alert per
// scope per month.

const alerted = new Set<string>();

/** YYYY-MM for "now". Kept as a function so the month rolls over correctly. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** First instant of the current UTC month, ISO-8601 — the month-to-date floor. */
function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function readBudget(scope: string): number | null {
  const v = getSettingOverride<number>(scope, BUDGET_KEY);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

/** Evaluate global + per-repo budgets for the scope(s) touched by a write. */
function checkBudgets(owner: string | null, repo: string | null): void {
  try {
    evaluateScope("global", null, null);
    if (owner && repo) evaluateScope(`${owner}/${repo}`, owner, repo);
  } catch (err) {
    logger.debug({ err }, "checkBudgets failed");
  }
}

function evaluateScope(scope: string, owner: string | null, repo: string | null): void {
  const budget = readBudget(scope);
  if (budget == null) return;
  // Include the ceiling in the dedupe key so a budget *change* mid-month can
  // alert again once the new ceiling is crossed, while a stable ceiling still
  // fires only once. (Without `budget`, lowering/raising-then-recrossing a
  // ceiling would be permanently suppressed for the rest of the process.)
  const dedupeKey = `${scope}|${currentMonth()}|${budget}`;
  if (alerted.has(dedupeKey)) return;
  const spent = getMonthToDateCost(owner, repo, monthStartIso());
  if (spent <= budget) return;
  alerted.add(dedupeKey);
  const payload = {
    scope,
    owner,
    repo,
    month: currentMonth(),
    spentUsd: Math.round(spent * 1e6) / 1e6,
    budgetUsd: budget,
  };
  logger.warn(payload, "AI spend budget exceeded");
  bus.publish("budget.exceeded", payload);
  recordEvent({
    owner: owner ?? "*",
    repo: repo ?? "*",
    number: null,
    kind: "budget.exceeded",
    payload,
  });
  insertAuditLog({
    actorLogin: "system",
    actorRole: null,
    action: "budget.exceeded",
    targetType: "budget",
    targetRef: scope,
    payload,
    result: "alert",
  });
}

/** Test/CLI hook: forget which scopes have already alerted this process. */
export function resetBudgetAlerts(): void {
  alerted.clear();
}
