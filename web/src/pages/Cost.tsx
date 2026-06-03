import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCost, useSetBudget } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, Metric, PageHeader } from "../components/primitives";
import { BudgetGauge, Donut, StackedBar, assignColors, type StackedDay } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { ApiError } from "../api/client";
import { formatTokens, formatUsd, relativeTime } from "../lib/format";
import type { CostDailyModelRow, CostResponse } from "../api/types";

const RANGES: { key: string; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "mtd", label: "Month to date" },
];

/** Number of day-columns a rolling range should span. */
function rollingDays(range: string): number {
  const m = /^(\d+)d$/.exec(range);
  return m ? Math.min(Number.parseInt(m[1], 10), 90) : 30;
}

/**
 * Bucket the per-day-per-model rows into a contiguous UTC day axis. For a rolling
 * range pass `days` (columns ending today); for month-to-date pass `startIso`
 * (the API's UTC month start) so the axis is anchored to the same window the API
 * summed — not `dayOfMonth - 1` days off the client clock, which can drift by a
 * day across a month boundary.
 */
function buildStackedDays(daily: CostDailyModelRow[], opts: { days?: number; startIso?: string | null }): StackedDay[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const r of daily) {
    const parts = byDay.get(r.day) ?? {};
    parts[r.model] = (parts[r.model] ?? 0) + r.cost_usd;
    byDay.set(r.day, parts);
  }
  const todayKey = new Date().toISOString().slice(0, 10);
  let startKey: string;
  if (opts.startIso) {
    startKey = opts.startIso.slice(0, 10);
  } else {
    const d = new Date(`${todayKey}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - ((opts.days ?? 30) - 1));
    startKey = d.toISOString().slice(0, 10);
  }
  const out: StackedDay[] = [];
  const cur = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(`${todayKey}T00:00:00.000Z`);
  // Walk start→today inclusive. The cap guards against a malformed startIso.
  while (cur <= end && out.length < 400) {
    const key = cur.toISOString().slice(0, 10);
    out.push({ day: key, parts: byDay.get(key) ?? {} });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function CostPage() {
  const [range, setRange] = useState("30d");
  const query = useCost(range);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Cost" }]} />
      <PageHeader
        title="AI spend"
        subtitle="Token usage and cost per provider call — reviews, chat, finishing touches, and issue triage."
        right={
          <div className="seg-toggle" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={`btn btn-ghost${r.key === range ? " active" : ""}`}
                style={r.key === range ? { color: "var(--text)" } : { color: "var(--text-3)" }}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading cost data…">
        {(data) => <CostBody data={data} range={range} />}
      </QueryBoundary>
    </>
  );
}

function CostBody({ data, range }: { data: CostResponse; range: string }) {
  const colors = useMemo(() => assignColors(data.models), [data.models]);
  const days = useMemo(
    () =>
      buildStackedDays(
        data.daily,
        range === "mtd" ? { startIso: data.since } : { days: rollingDays(range) },
      ),
    [data.daily, range, data.since],
  );

  const totalTokens = data.totals.input_tokens + data.totals.output_tokens;
  const projOver = data.budgets.find((b) => b.scope === "global");
  const projTone =
    projOver && projOver.monthlyUsd > 0 && data.projectedMonthEnd > projOver.monthlyUsd ? "danger" : undefined;

  return (
    <>
      <div className="grid hero" style={{ marginBottom: 20 }}>
        <Card
          title="Spend over time"
          subtitle={`${formatUsd(data.totals.cost_usd)} across ${data.totals.events.toLocaleString()} calls · stacked by model`}
          bodyClass="chart"
        >
          <StackedBar days={days} order={data.models} colors={colors} formatValue={formatUsd} />
        </Card>
        <div className="grid stack">
          <Metric
            label="This window"
            value={formatUsd(data.totals.cost_usd)}
            hero
            foot={<Chip tone="muted" uppercase>{formatTokens(totalTokens)} tokens</Chip>}
          />
          <div className="grid three" style={{ gap: 10 }}>
            <Metric label="Month to date" value={formatUsd(data.monthToDate)} />
            <Metric
              label="Projected mo-end"
              value={formatUsd(data.projectedMonthEnd)}
              tone={projTone === "danger" ? "danger" : undefined}
            />
            <Metric label="Calls" value={data.totals.events.toLocaleString()} />
          </div>
        </div>
      </div>

      <div className="grid two" style={{ marginBottom: 20 }}>
        <Card title="Top repositories" subtitle="By spend in this window" bodyClass="flush">
          {data.byRepo.length === 0 ? (
            <EmptyState title="No repo spend yet" hint="Cost is attributed once a review records usage." />
          ) : (
            <CostBars
              rows={data.byRepo.map((r) => ({
                key: r.key,
                cost: r.cost_usd,
                href: repoHref(r.key),
                sub: `${formatTokens(r.input_tokens + r.output_tokens)} tok · ${r.events} calls`,
              }))}
            />
          )}
        </Card>
        <Card title="Cost by kind" subtitle="Where spend goes">
          {data.byKind.length === 0 ? (
            <EmptyState title="No spend yet" />
          ) : (
            <Donut
              slices={data.byKind.map((k, i) => ({
                label: k.key,
                value: Math.round(k.cost_usd * 1e6) / 1e6,
                color: KIND_COLORS[i % KIND_COLORS.length],
              }))}
            />
          )}
        </Card>
      </div>

      <Card title="Tokens vs. cost by model" subtitle="Input/output tokens and dollars per model" bodyClass="flush">
        {data.byModel.length === 0 ? (
          <EmptyState title="No model usage yet" hint="Run a review to populate this table." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Input tok</th>
                <th className="num">Output tok</th>
                <th className="num">Calls</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => (
                <tr key={m.key}>
                  <td>
                    <span className="sw-inline" style={{ background: colors.get(m.key) ?? "#5a8dff" }} />
                    <span className="mono">{m.key}</span>
                  </td>
                  <td className="num mono">{formatTokens(m.input_tokens)}</td>
                  <td className="num mono">{formatTokens(m.output_tokens)}</td>
                  <td className="num mono">{m.events.toLocaleString()}</td>
                  <td className="num mono strong">{formatUsd(m.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <BudgetsCard data={data} />
      </div>
    </>
  );
}

const KIND_COLORS = ["#5a8dff", "#9a6bff", "#4ade80", "#fbbf24", "#fb923c", "#fb6d82", "#22d3ee"];

function repoHref(key: string): string | undefined {
  const parts = key.split("/");
  if (parts.length !== 2 || parts.some((p) => !p || p === "?")) return undefined;
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

/** Simple horizontal cost bars (largest first; the list is already sorted). */
function CostBars({ rows }: { rows: { key: string; cost: number; href?: string; sub?: string }[] }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.cost));
  return (
    <div className="costbars">
      {rows.map((r) => {
        const pct = (r.cost / max) * 100;
        const label = r.href ? (
          <Link to={r.href} className="cb-name mono">
            {r.key}
          </Link>
        ) : (
          <span className="cb-name mono">{r.key}</span>
        );
        return (
          <div className="cb-row" key={r.key}>
            <div className="cb-top">
              {label}
              <span className="cb-cost mono">{formatUsd(r.cost)}</span>
            </div>
            <div className="cb-track">
              <div className="cb-fill" style={{ width: `${pct.toFixed(1)}%` }} />
            </div>
            {r.sub ? <div className="cb-sub muted">{r.sub}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function BudgetsCard({ data }: { data: CostResponse }) {
  const { capabilities } = useAuth();
  const canEdit = capabilities.manageConfig;
  const setBudget = useSetBudget();
  const [scope, setScope] = useState("global");
  const [amount, setAmount] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = scope.trim();
    const n = Number.parseFloat(amount);
    if (!s || !Number.isFinite(n) || n <= 0) return;
    setBudget.mutate({ scope: s, monthlyUsd: n }, { onSuccess: () => setAmount("") });
  };

  const clear = (s: string) => setBudget.mutate({ scope: s, monthlyUsd: null });
  const err = setBudget.error instanceof ApiError ? setBudget.error.message : setBudget.error ? "Failed to update budget." : null;
  const repoScopes = data.byRepo.map((r) => r.key).filter((k) => k.split("/").every((p) => p && p !== "?"));

  return (
    <Card
      title="Budgets"
      subtitle="Monthly USD ceilings per scope. Crossing one emits a live alert and is recorded in the audit log."
    >
      {data.budgets.length === 0 ? (
        <EmptyState
          title="No budgets set"
          hint={canEdit ? "Add a monthly ceiling below to start tracking against it." : "An admin can set monthly ceilings here."}
        />
      ) : (
        <div className="grid two" style={{ gap: 14, marginBottom: canEdit ? 18 : 0 }}>
          {data.budgets.map((b) => (
            <div key={b.scope} className="budget-cell">
              <BudgetGauge
                label={b.scope}
                spentUsd={b.spentUsd}
                monthlyUsd={b.monthlyUsd}
                pct={b.pct}
                exceeded={b.exceeded}
                formatValue={formatUsd}
              />
              {canEdit ? (
                <button className="btn btn-link" onClick={() => clear(b.scope)} disabled={setBudget.isPending}>
                  Clear
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canEdit ? (
        <>
          <form onSubmit={submit} className="role-form" style={{ marginTop: data.budgets.length ? 0 : 4 }}>
            <label className="field">
              Scope
              <input
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="global or owner/repo"
                list="budget-scopes"
                autoComplete="off"
              />
              <datalist id="budget-scopes">
                <option value="global" />
                {repoScopes.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
            <label className="field">
              Monthly USD
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                inputMode="decimal"
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={setBudget.isPending || !scope.trim() || !(Number.parseFloat(amount) > 0)}
            >
              {setBudget.isPending ? "Saving…" : "Set budget"}
            </button>
          </form>
          {err ? <p style={{ color: "var(--sev-crit)", fontSize: 12.5, marginTop: 10 }}>{err}</p> : null}
          {data.budgets.some((b) => b.updatedAt) ? (
            <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
              Last change {relativeTime(data.budgets.map((b) => b.updatedAt ?? "").sort().at(-1) || null)}.
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
