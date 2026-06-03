// Inline-SVG / CSS charts — React ports of stackedSeverityBar(), miniSparkbar(),
// riskLine(), hbar(), and donut() from src/dashboard/layout.ts.

import type { DayBin } from "../lib/format";
import type { SparklinePoint } from "../api/types";
import { EmptyState } from "./states";

export function StackedSeverityBar({ series }: { series: DayBin[] }) {
  const max = Math.max(1, ...series.map((d) => d.critical + d.major + d.minor + d.nit));
  const totals = series.reduce(
    (acc, d) => {
      acc.critical += d.critical;
      acc.major += d.major;
      acc.minor += d.minor;
      acc.nit += d.nit;
      return acc;
    },
    { critical: 0, major: 0, minor: 0, nit: 0 },
  );
  const pct = (n: number) => (n === 0 ? 0 : (n / max) * 100);
  const midIdx = Math.floor(series.length / 2);
  return (
    <>
      <div className="chart-bar">
        {series.map((d, i) => {
          const total = d.critical + d.major + d.minor + d.nit;
          if (total === 0) {
            return (
              <div className="col" key={i} title={`${d.day} · no reviews`}>
                <div className="empty-dot" />
              </div>
            );
          }
          const title = `${d.day} · ${total} finding${total === 1 ? "" : "s"} (crit ${d.critical} · maj ${d.major} · min ${d.minor} · nit ${d.nit})`;
          return (
            <div className="col" key={i} title={title}>
              {d.nit > 0 && <div className="seg nit" style={{ height: `${pct(d.nit).toFixed(1)}%` }} />}
              {d.minor > 0 && <div className="seg minor" style={{ height: `${pct(d.minor).toFixed(1)}%` }} />}
              {d.major > 0 && <div className="seg major" style={{ height: `${pct(d.major).toFixed(1)}%` }} />}
              {d.critical > 0 && <div className="seg crit" style={{ height: `${pct(d.critical).toFixed(1)}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="chart-xaxis">
        {series.map((d, i) => {
          const show = i === 0 || i === midIdx || i === series.length - 1;
          return <span key={i}>{show ? d.day.slice(5) : ""}</span>;
        })}
      </div>
      <div className="chart-legend">
        <span className="it crit">
          <span className="sw" />
          Critical<span className="count">{totals.critical}</span>
        </span>
        <span className="it major">
          <span className="sw" />
          Major<span className="count">{totals.major}</span>
        </span>
        <span className="it minor">
          <span className="sw" />
          Minor<span className="count">{totals.minor}</span>
        </span>
        <span className="it nit">
          <span className="sw" />
          Nit<span className="count">{totals.nit}</span>
        </span>
      </div>
    </>
  );
}

export function MiniSparkbar({ series }: { series: DayBin[] }) {
  const max = Math.max(1, ...series.map((d) => d.critical + d.major + d.minor + d.nit));
  return (
    <div className="spark-14" aria-hidden="true">
      {series.map((d, i) => {
        const total = d.critical + d.major + d.minor + d.nit;
        if (total === 0) return <div className="col" key={i} title={`${d.day} · 0`} />;
        const h = Math.max(4, (total / max) * 100);
        let cls = "has";
        if (d.critical > 0) cls = "has-crit";
        else if (d.major > 0) cls = "has-major";
        else if (d.minor > 0) cls = "has-minor";
        return <div className={`col ${cls}`} key={i} style={{ height: `${h.toFixed(0)}%` }} title={`${d.day} · ${total}`} />;
      })}
    </div>
  );
}

export function RiskLine({ points }: { points: SparklinePoint[] }) {
  if (points.length < 2) {
    return <EmptyState title="Not enough data yet" hint="Need at least two reviews to trace risk over time." />;
  }
  const w = 720;
  const h = 140;
  const padT = 12;
  const padB = 22;
  const innerH = h - padT - padB;
  const n = points.length;
  const coords = points.map((p, i) => {
    const x = (i * w) / Math.max(1, n - 1);
    const score = typeof p.risk_score === "number" ? p.risk_score : 0;
    const y = padT + innerH - (score / 100) * innerH;
    return { x, y, score, p };
  });
  const path = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath = `0,${padT + innerH} ${path} ${w},${padT + innerH}`;
  return (
    <div className="risk-chart-wrap">
      <div className="axis">
        {[0, 25, 50, 75, 100].map((p) => {
          const yPx = padT + innerH - (p / 100) * innerH;
          const topPct = (yPx / h) * 100;
          return (
            <div key={p}>
              <div className="gridline" style={{ top: `${topPct.toFixed(2)}%` }} />
              <div className="ylabel" style={{ top: `${topPct.toFixed(2)}%` }}>
                {p}
              </div>
            </div>
          );
        })}
      </div>
      <div className="plot">
        <svg viewBox={`0 0 ${w} ${h}`} className="risk-chart" preserveAspectRatio="none">
          <defs>
            <linearGradient id="riskGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#5a8dff" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#5a8dff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={areaPath} className="area" />
          <polyline points={path} className="line" />
        </svg>
      </div>
      <div className="dots">
        {coords.map((c, i) => {
          const color =
            c.score >= 75 ? "#fb6d82" : c.score >= 55 ? "#fb923c" : c.score >= 35 ? "#fbbf24" : c.score >= 15 ? "#facc15" : "#4ade80";
          const leftPct = n === 1 ? 0 : (c.x / w) * 100;
          const topPct = (c.y / h) * 100;
          return (
            <div
              key={i}
              className="dot-marker"
              style={{ left: `${leftPct.toFixed(2)}%`, top: `${topPct.toFixed(2)}%`, background: color }}
              title={`#${c.p.number} · risk ${c.score} · ${c.p.created_at.slice(0, 10)}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function Hbar({ label, critical, major, total, max, href }: { label: string; critical: number; major: number; total: number; max: number; href?: string }) {
  const pctCrit = max > 0 ? (critical / max) * 100 : 0;
  const pctMaj = max > 0 ? (major / max) * 100 : 0;
  return (
    <div className="hbar-row">
      <div className="label">
        {href ? (
          <a className="path" href={href} style={{ color: "inherit" }}>
            {label}
          </a>
        ) : (
          <span className="path">{label}</span>
        )}
        <div className="hb-track">
          {critical > 0 && <div className="hb-seg crit" style={{ width: `${pctCrit.toFixed(1)}%` }} />}
          {major > 0 && <div className="hb-seg major" style={{ width: `${pctMaj.toFixed(1)}%` }} />}
        </div>
      </div>
      <div className="num">{total}</div>
    </div>
  );
}

// ── Cost charts ──────────────────────────────────────────────────────

/** Stable categorical palette for model/series coloring. */
export const SERIES_COLORS = [
  "#5a8dff",
  "#9a6bff",
  "#4ade80",
  "#fbbf24",
  "#fb923c",
  "#fb6d82",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#94a3b8",
] as const;

/** Assign a stable color to each key, in the order given. */
export function assignColors(keys: string[]): Map<string, string> {
  const m = new Map<string, string>();
  keys.forEach((k, i) => m.set(k, SERIES_COLORS[i % SERIES_COLORS.length]));
  return m;
}

export interface StackedDay {
  day: string; // YYYY-MM-DD
  /** Per-series value for this day, keyed by series name. */
  parts: Record<string, number>;
}

/**
 * Generic stacked daily bar (e.g. spend per day, segmented by model). Colors
 * come from `colors`; series stack in `order`. Reuses the .chart-bar primitives
 * with inline segment colors since the series set is dynamic.
 */
export function StackedBar({
  days,
  order,
  colors,
  formatValue,
}: {
  days: StackedDay[];
  order: string[];
  colors: Map<string, string>;
  formatValue: (n: number) => string;
}) {
  const totals = days.map((d) => order.reduce((s, k) => s + (d.parts[k] ?? 0), 0));
  const max = Math.max(1e-9, ...totals);
  const grandTotal = totals.reduce((s, n) => s + n, 0);
  const midIdx = Math.floor(days.length / 2);
  if (grandTotal <= 0) {
    return <EmptyState title="No spend in this window" hint="Run a review to start recording cost events." />;
  }
  return (
    <>
      <div className="chart-bar">
        {days.map((d, i) => {
          const total = totals[i];
          if (total <= 0) {
            return (
              <div className="col" key={i} title={`${d.day} · no spend`}>
                <div className="empty-dot" />
              </div>
            );
          }
          const title = `${d.day} · ${formatValue(total)}`;
          return (
            <div className="col" key={i} title={title}>
              {order.map((k) => {
                const v = d.parts[k] ?? 0;
                if (v <= 0) return null;
                const h = (v / max) * 100;
                return (
                  <div
                    key={k}
                    className="seg"
                    style={{ height: `${h.toFixed(1)}%`, background: colors.get(k) ?? "#5a8dff" }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="chart-xaxis">
        {days.map((d, i) => {
          const show = i === 0 || i === midIdx || i === days.length - 1;
          return <span key={i}>{show ? d.day.slice(5) : ""}</span>;
        })}
      </div>
      <div className="chart-legend">
        {order.map((k) => (
          <span className="it" key={k}>
            <span className="sw" style={{ background: colors.get(k) ?? "#5a8dff" }} />
            {k}
          </span>
        ))}
      </div>
    </>
  );
}

/** A single budget gauge: spent vs. monthly ceiling, color by utilization. */
export function BudgetGauge({
  label,
  spentUsd,
  monthlyUsd,
  pct,
  exceeded,
  formatValue,
}: {
  label: string;
  spentUsd: number;
  monthlyUsd: number;
  pct: number;
  exceeded: boolean;
  formatValue: (n: number) => string;
}) {
  const tone = exceeded ? "crit" : pct >= 80 ? "warn" : "good";
  const fillPct = Math.min(100, Math.max(0, pct));
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="gauge-label" title={label}>
          {label}
        </span>
        <span className={`gauge-pct ${tone}`}>{pct}%</span>
      </div>
      <div className="gauge-track">
        <div className={`gauge-fill ${tone}`} style={{ width: `${fillPct.toFixed(1)}%` }} />
      </div>
      <div className="gauge-foot">
        <span className="mono">{formatValue(spentUsd)}</span>
        <span className="muted"> / {formatValue(monthlyUsd)} mo</span>
        {exceeded ? <span className="gauge-flag">over budget</span> : null}
      </div>
    </div>
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function Donut({ slices, size = 120 }: { slices: DonutSlice[]; size?: number }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut" aria-hidden="true">
        <circle className="bg" cx={size / 2} cy={size / 2} r={r} />
        {total > 0 &&
          slices.map((s, i) => {
            if (s.value === 0) return null;
            const frac = s.value / total;
            const dash = frac * c;
            const seg = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={s.color}
                strokeDasharray={`${dash.toFixed(1)} ${(c - dash).toFixed(1)}`}
                strokeDashoffset={(-offset).toFixed(1)}
              />
            );
            offset += dash;
            return seg;
          })}
      </svg>
      <div className="donut-legend">
        {slices.map((s, i) => {
          const pct = total === 0 ? 0 : (s.value / total) * 100;
          return (
            <div className="it" key={i}>
              <span className="sw" style={{ background: s.color }} />
              <span className="label">{s.label}</span>
              <span className="num mono">{s.value}</span>
              <div className="bar">
                <div className="fill" style={{ width: `${pct.toFixed(1)}%`, background: s.color }} />
              </div>
              <div className="pct">{pct.toFixed(pct >= 10 ? 0 : 1)}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
