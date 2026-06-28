// Inline-SVG / CSS charts — React ports of stackedSeverityBar(), miniSparkbar(),
// riskLine(), hbar(), and donut() from src/dashboard/layout.ts.

import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DayBin } from "../lib/format";
import type { Severity, SparklinePoint } from "../api/types";
import { EmptyState } from "./states";
import { ChartTooltip, useChartTooltip } from "./ChartTooltip";

// Severity rows in stacking order (bottom → top) with their legend metadata.
// `cls` matches the existing .seg / .chart-legend color classes in base.css.
const SEVERITIES: Array<{ key: Severity; cls: string; label: string }> = [
  { key: "nit", cls: "nit", label: "Nit" },
  { key: "minor", cls: "minor", label: "Minor" },
  { key: "major", cls: "major", label: "Major" },
  { key: "critical", cls: "crit", label: "Critical" },
];

/**
 * Stacked per-day severity bar. Each column shows a hover/focus tooltip with the
 * date and full breakdown. When `hrefForSeverity` is supplied the colored
 * segments and legend swatches become drill-through links into a filtered
 * Findings view (segment = severity), giving "click a segment → see those
 * findings". Day-level drill-through isn't offered because the Findings API has
 * no exact-date filter — severity is the meaningful axis to slice on.
 */
export function StackedSeverityBar({
  series,
  hrefForSeverity,
}: {
  series: DayBin[];
  hrefForSeverity?: (severity: Severity) => string;
}) {
  const navigate = useNavigate();
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
  const tooltip = useChartTooltip();

  // Legend is shown critical → nit (top of the stack first).
  const legend = [...SEVERITIES].reverse();

  return (
    <>
      <div className="chart-bar">
        {series.map((d, i) => {
          const total = d.critical + d.major + d.minor + d.nit;
          const summary =
            total === 0
              ? `${d.day} · no reviews`
              : `${d.day} · ${total} finding${total === 1 ? "" : "s"} (crit ${d.critical} · maj ${d.major} · min ${d.minor} · nit ${d.nit})`;
          const tip = (
            <>
              <div className="tip-title">{d.day}</div>
              {total === 0 ? (
                <div className="tip-sub">no reviews</div>
              ) : (
                <>
                  <div className="tip-sub">
                    {total} finding{total === 1 ? "" : "s"}
                  </div>
                  {legend.map((s) => (
                    <div className="tip-row" key={s.key}>
                      <span className="k">
                        <span className={`sw ${s.cls}`} />
                        {s.label}
                      </span>
                      <span className="v">{d[s.key]}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          );
          // The column is the single image node that announces the whole-day
          // summary; its segments are non-semantic boxes (no nested links). When
          // drill-through is on a segment is a mouse-only click target that
          // navigates programmatically — it stays out of the a11y tree and tab
          // order (the column's role="img" makes the subtree presentational), so
          // the four legend entries remain the clean keyboard/SR drill targets
          // instead of dozens of redundant per-bar tab stops.
          return (
            <div key={i} className="col" role="img" aria-label={summary} {...tooltip.bind(tip)}>
              {total === 0 ? (
                <div className="empty-dot" />
              ) : (
                SEVERITIES.map((s) => {
                  const v = d[s.key];
                  if (v <= 0) return null;
                  const style = { height: `${pct(v).toFixed(1)}%` };
                  if (hrefForSeverity) {
                    return (
                      <div
                        key={s.key}
                        className={`seg ${s.cls} clickable`}
                        style={style}
                        onClick={() => navigate(hrefForSeverity(s.key))}
                      />
                    );
                  }
                  return <div key={s.key} className={`seg ${s.cls}`} style={style} />;
                })
              )}
            </div>
          );
        })}
        <ChartTooltip tip={tooltip.tip} />
      </div>
      <div className="chart-xaxis">
        {series.map((d, i) => {
          const show = i === 0 || i === midIdx || i === series.length - 1;
          return <span key={i}>{show ? d.day.slice(5) : ""}</span>;
        })}
      </div>
      <div className="chart-legend">
        {legend.map((s) => {
          const inner = (
            <>
              <span className="sw" />
              {s.label}
              <span className="count">{totals[s.key]}</span>
            </>
          );
          return hrefForSeverity ? (
            <Link
              key={s.key}
              className={`it ${s.cls}`}
              to={hrefForSeverity(s.key)}
              aria-label={`View ${totals[s.key]} ${s.label.toLowerCase()} ${totals[s.key] === 1 ? "finding" : "findings"} in Findings`}
            >
              {inner}
            </Link>
          ) : (
            <span className={`it ${s.cls}`} key={s.key}>
              {inner}
            </span>
          );
        })}
      </div>
    </>
  );
}

export function MiniSparkbar({ series }: { series: DayBin[] }) {
  const max = Math.max(1, ...series.map((d) => d.critical + d.major + d.minor + d.nit));
  // Decorative inside the repo-card link (the card itself is the labelled
  // target), so it stays aria-hidden — but each bar keeps a native title with
  // the date + severity breakdown for a quick hover read.
  return (
    <div className="spark-14" aria-hidden="true">
      {series.map((d, i) => {
        const total = d.critical + d.major + d.minor + d.nit;
        if (total === 0) return <div className="col" key={i} title={`${d.day} · no findings`} />;
        const h = Math.max(4, (total / max) * 100);
        let cls = "has";
        if (d.critical > 0) cls = "has-crit";
        else if (d.major > 0) cls = "has-major";
        else if (d.minor > 0) cls = "has-minor";
        const title = `${d.day} · ${total} finding${total === 1 ? "" : "s"} (crit ${d.critical} · maj ${d.major} · min ${d.minor} · nit ${d.nit})`;
        return <div className={`col ${cls}`} key={i} style={{ height: `${h.toFixed(0)}%` }} title={title} />;
      })}
    </div>
  );
}

/**
 * Risk-score line over time. Adds dated x-axis ticks (first / mid / last review),
 * hover+focus tooltips on each point (PR #, risk, date), and — when
 * `hrefForPoint` is supplied — turns each point into a drill-through link to
 * that PR.
 */
export function RiskLine({
  points,
  hrefForPoint,
}: {
  points: SparklinePoint[];
  hrefForPoint?: (point: SparklinePoint) => string;
}) {
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
  const tooltip = useChartTooltip();
  const midIdx = Math.floor((n - 1) / 2);
  const ticks = [0, midIdx, n - 1].filter((v, i, a) => a.indexOf(v) === i);
  // Per-instance gradient id so multiple RiskLine charts on one page don't
  // collide on a shared SVG id (colons from useId stripped for funcIRI safety).
  const gradId = `riskGrad-${useId().replace(/:/g, "")}`;

  return (
    <div className="risk-chart-wrap">
      <div className="risk-area">
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
              {/* Gradient stops read the theme accent via inline style — CSS
                 custom properties don't resolve in bare SVG presentation attrs. */}
              <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.35 }} />
                <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <polygon points={areaPath} className="area" fill={`url(#${gradId})`} />
            <polyline points={path} className="line" />
          </svg>
        </div>
        <div className="dots">
          {coords.map((c, i) => {
            const color =
              c.score >= 75
                ? "var(--sev-crit)"
                : c.score >= 55
                  ? "var(--sev-major)"
                  : c.score >= 35
                    ? "var(--sev-minor)"
                    : c.score >= 15
                      ? "var(--warn)"
                      : "var(--good)";
            const leftPct = n === 1 ? 0 : (c.x / w) * 100;
            const topPct = (c.y / h) * 100;
            const date = c.p.created_at.slice(0, 10);
            const label = `PR #${c.p.number} · risk ${c.score} · ${date}`;
            const tip = (
              <>
                <div className="tip-title">PR #{c.p.number}</div>
                <div className="tip-row">
                  <span className="k">Risk</span>
                  <span className="v">{c.score}</span>
                </div>
                <div className="tip-sub">{date}</div>
              </>
            );
            const style = { left: `${leftPct.toFixed(2)}%`, top: `${topPct.toFixed(2)}%`, background: color };
            return hrefForPoint ? (
              <Link
                key={i}
                className="dot-marker"
                style={style}
                to={hrefForPoint(c.p)}
                aria-label={`${label} — open PR`}
                {...tooltip.bind(tip)}
              />
            ) : (
              <div key={i} className="dot-marker" style={style} role="img" aria-label={label} {...tooltip.bind(tip)} />
            );
          })}
        </div>
      </div>
      <div className="risk-xaxis" aria-hidden="true">
        {ticks.map((idx, j) => (
          <span key={idx} className={ticks.length === 3 && j === 1 ? "mid" : undefined}>
            {points[idx].created_at.slice(5, 10)}
          </span>
        ))}
      </div>
      <ChartTooltip tip={tooltip.tip} />
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

/**
 * Compact SVG line sparkline for a single numeric series — used for per-author
 * activity trends and hot-path-over-time rows. Renders a flat baseline when the
 * series is empty/all-zero so sparse histories don't collapse to nothing.
 */
export function LineSpark({
  values,
  color = "var(--accent)",
  width = 120,
  height = 28,
  title,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  title?: string;
}) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const pad = 2;
  const innerH = height - pad * 2;
  const baselineY = pad + innerH;
  const yFor = (v: number) => pad + innerH - (v / max) * innerH;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? width / 2 : (i * width) / (n - 1);
    return `${x.toFixed(1)},${yFor(v).toFixed(1)}`;
  });
  // 0 points → flat baseline; 1 point → horizontal line at its scaled height
  // (a lone non-zero reading shouldn't look identical to all-zero); else polyline.
  const line =
    n === 0
      ? `0,${baselineY.toFixed(1)} ${width},${baselineY.toFixed(1)}`
      : n === 1
        ? `0,${yFor(values[0]).toFixed(1)} ${width},${yFor(values[0]).toFixed(1)}`
        : pts.join(" ");
  // With a title the sparkline is a labelled image for assistive tech; without
  // one it's decorative and hidden so screen readers don't announce empty SVG.
  return (
    <svg
      className="line-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
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
  const tooltip = useChartTooltip();
  // Hovering/focusing a segment or its legend row highlights the pair and dims
  // the rest. Both sides share one tooltip-content builder so the arc and its
  // legend entry show the identical popover.
  const [active, setActive] = useState<number | null>(null);
  const fmtPct = (v: number) => (total === 0 ? 0 : (v / total) * 100);
  const tipFor = (s: DonutSlice) => {
    const pct = fmtPct(s.value);
    return (
      <>
        <div className="tip-title">
          <span className="sw" style={{ background: s.color }} />
          {s.label}
        </div>
        <div className="tip-row">
          <span className="k">Count</span>
          <span className="v">{s.value}</span>
        </div>
        <div className="tip-row">
          <span className="k">Share</span>
          <span className="v">{pct.toFixed(pct >= 10 ? 0 : 1)}%</span>
        </div>
      </>
    );
  };

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
            const pct = fmtPct(s.value);
            const tip = tipFor(s);
            const cls = active === null ? "" : active === i ? "active" : "dim";
            const seg = (
              <circle
                key={i}
                className={cls}
                cx={size / 2}
                cy={size / 2}
                r={r}
                // style (not the bare `stroke` attr) so CSS var colors resolve.
                style={{ stroke: s.color }}
                strokeDasharray={`${dash.toFixed(1)} ${(c - dash).toFixed(1)}`}
                strokeDashoffset={(-offset).toFixed(1)}
                onMouseEnter={(e) => {
                  setActive(i);
                  tooltip.bind(tip).onMouseEnter(e);
                }}
                onMouseMove={tooltip.bind(tip).onMouseMove}
                onMouseLeave={() => {
                  setActive(null);
                  tooltip.hide();
                }}
              >
                <title>{`${s.label}: ${s.value} (${pct.toFixed(pct >= 10 ? 0 : 1)}%)`}</title>
              </circle>
            );
            offset += dash;
            return seg;
          })}
      </svg>
      <div className="donut-legend">
        {slices.map((s, i) => {
          const pct = fmtPct(s.value);
          const tip = tipFor(s);
          const handlers = tooltip.bind(tip);
          const enter = () => setActive(i);
          const leave = () => {
            setActive(null);
            tooltip.hide();
          };
          return (
            <div
              className={`it${active === i ? " active" : ""}`}
              key={i}
              tabIndex={0}
              onMouseEnter={(e) => {
                enter();
                handlers.onMouseEnter(e);
              }}
              onMouseMove={handlers.onMouseMove}
              onMouseLeave={leave}
              onFocus={(e) => {
                enter();
                handlers.onFocus(e);
              }}
              onBlur={leave}
            >
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
      <ChartTooltip tip={tooltip.tip} />
    </div>
  );
}
