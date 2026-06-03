import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { BUDGET_KEY } from "../ai/cost.js";
import { upsertSettingOverride, deleteSettingOverride, insertAuditLog } from "../storage/dao.js";
import {
  getBudgets,
  getCostByGroup,
  getCostDailyByModel,
  getCostTotals,
  getMonthToDateCost,
} from "../dashboard/queries.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cost API — read the AI-spend rollups (any authenticated role) and manage
// per-scope monthly budgets (admin). GET is a pure read over cost_events; the
// budget write follows the same contract as the other command-center writes
// (requireRole + CSRF + audit_log).
// ─────────────────────────────────────────────────────────────────────────────

export interface CostDeps {
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

type ErrorCode = "forbidden" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Map a `range` query value to a since-ISO floor (undefined = all time). */
function rangeToSince(range: string, now: Date): { range: string; since?: string } {
  if (range === "all") return { range };
  if (range === "mtd") {
    return { range, since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() };
  }
  const m = /^(\d{1,4})d$/.exec(range);
  const days = m ? Math.min(Number.parseInt(m[1], 10), 3650) : 30;
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { range: `${days}d`, since };
}

function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Days in the current UTC month — for the linear month-end projection. */
function daysInMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 'global' or exactly 'owner/repo' (two non-empty segments). */
function isValidScope(scope: string): boolean {
  if (scope === "global") return true;
  const parts = scope.split("/");
  return parts.length === 2 && parts.every((p) => p.length > 0);
}

/** Month-to-date spend for a budget scope. */
function spentForScope(scope: string, monthStart: string): number {
  if (scope === "global") return getMonthToDateCost(null, null, monthStart);
  const [owner, repo] = scope.split("/");
  return getMonthToDateCost(owner, repo, monthStart);
}

export function registerCostRoutes(router: Router, deps: CostDeps): void {
  const { requireRole, csrf } = deps;

  // ── GET /cost ───────────────────────────────────────────────────────
  // Rich rollup the Cost page renders in one request: windowed totals, spend by
  // model/repo/kind, the per-day-per-model series, month-to-date + projection,
  // and every configured budget with its month-to-date spend (for the gauges).
  router.get("/cost", (req: Request, res: Response) => {
    try {
      const now = new Date();
      const q = req.query as Record<string, unknown>;
      const rawRange = typeof q.range === "string" ? q.range : "30d";
      const { range, since } = rangeToSince(rawRange, now);
      const rawGroup = typeof q.group === "string" ? q.group : "";
      const group =
        rawGroup === "repo" || rawGroup === "model" || rawGroup === "day" || rawGroup === "kind"
          ? rawGroup
          : undefined;

      const totals = getCostTotals({ sinceIso: since });
      const byModel = getCostByGroup({ group: "model", sinceIso: since, limit: 50 });
      const byRepo = getCostByGroup({ group: "repo", sinceIso: since, limit: 50 });
      const byKind = getCostByGroup({ group: "kind", sinceIso: since, limit: 50 });
      const daily = getCostDailyByModel({ sinceIso: since });
      // Distinct models ordered by spend — the stacking order for the chart.
      const models = byModel.map((m) => m.key);

      // Month-to-date + naive linear projection to month end.
      const monthStart = monthStartIso(now);
      const monthToDate = round(getMonthToDateCost(null, null, monthStart));
      const dayOfMonth = now.getUTCDate();
      const dim = daysInMonth(now);
      const projectedMonthEnd = dayOfMonth > 0 ? round((monthToDate / dayOfMonth) * dim) : monthToDate;

      // Budgets with their month-to-date spend (powers the gauges + alerts).
      const budgets = getBudgets().map((b) => {
        const spent = round(spentForScope(b.scope, monthStart));
        return {
          scope: b.scope,
          monthlyUsd: b.monthly_usd,
          spentUsd: spent,
          pct: b.monthly_usd > 0 ? Math.round((spent / b.monthly_usd) * 100) : 0,
          exceeded: spent > b.monthly_usd,
          updatedBy: b.updated_by,
          updatedAt: b.updated_at,
        };
      });

      // Optional explicit grouping echo for the documented ?group= param.
      const grouped = group ? getCostByGroup({ group, sinceIso: since, limit: 200 }) : undefined;

      sendData(res, {
        range,
        since: since ?? null,
        group: group ?? null,
        totals,
        monthToDate,
        projectedMonthEnd,
        dayOfMonth,
        daysInMonth: dim,
        byModel,
        byRepo,
        byKind,
        daily,
        models,
        budgets,
        ...(grouped ? { grouped } : {}),
      });
    } catch (err) {
      logger.error({ err }, "api /cost failed");
      sendError(res, 500, "internal", "Failed to load cost data.");
    }
  });

  // ── POST /cost/budget (admin) ───────────────────────────────────────
  // Set or clear a monthly budget for a scope. body: { scope, monthlyUsd }.
  // monthlyUsd null/0 clears the budget (reverts to "no ceiling").
  router.post("/cost/budget", requireRole("admin"), csrf.verify, (req: Request, res: Response) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    if (!isValidScope(scope)) {
      sendError(res, 400, "bad_request", "'scope' must be 'global' or 'owner/repo'.");
      return;
    }
    const raw = body.monthlyUsd;
    const clearing = raw == null || raw === "" || raw === 0 || raw === "0";
    let monthlyUsd = 0;
    if (!clearing) {
      monthlyUsd = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
        sendError(res, 400, "bad_request", "'monthlyUsd' must be a positive number (or null/0 to clear).");
        return;
      }
    }
    try {
      if (clearing) {
        deleteSettingOverride(scope, BUDGET_KEY);
      } else {
        upsertSettingOverride({ scope, key: BUDGET_KEY, value: monthlyUsd, updatedBy: actor?.login ?? null });
      }
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: clearing ? "budget.clear" : "budget.set",
        targetType: "budget",
        targetRef: scope,
        payload: { monthlyUsd: clearing ? null : monthlyUsd },
        result: "ok",
      });
      sendData(res, { scope, monthlyUsd: clearing ? null : monthlyUsd });
    } catch (err) {
      logger.error({ err, scope }, "api POST /cost/budget failed");
      sendError(res, 500, "internal", "Failed to update budget.");
    }
  });
}
