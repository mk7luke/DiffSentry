import { useSearchParams } from "react-router-dom";
import { useTrends } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { Donut, LineSpark, StackedSeverityBar, type DonutSlice } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { buildDaySeries, type DayBin } from "../lib/format";
import { DaysPicker, normalizeDays } from "./Leaderboard";
import type { DailyActivityRow, HotPathTrendPoint, RiskBucketRow } from "../api/types";

// Risk levels in severity order, with the colors used by the risk badge.
const RISK_LEVELS: Array<{ key: string; label: string; color: string }> = [
  { key: "critical", label: "Critical", color: "var(--sev-crit)" },
  { key: "high", label: "High", color: "var(--sev-major)" },
  { key: "elevated", label: "Elevated", color: "var(--sev-minor)" },
  { key: "moderate", label: "Moderate", color: "var(--warn)" },
  { key: "low", label: "Low", color: "var(--good)" },
  { key: "unscored", label: "Unscored", color: "var(--sev-nit)" },
];

/** Collapse per-repo daily rows into one bin per day, then fill the window. */
function orgDaySeries(rows: DailyActivityRow[], days: number): DayBin[] {
  const byDay = new Map<string, DayBin>();
  for (const r of rows) {
    const b = byDay.get(r.day) ?? { day: r.day, reviews: 0, critical: 0, major: 0, minor: 0, nit: 0 };
    b.reviews += r.reviews;
    b.critical += r.critical;
    b.major += r.major;
    b.minor += r.minor;
    b.nit += r.nit;
    byDay.set(r.day, b);
  }
  return buildDaySeries([...byDay.values()], Math.min(days, 30));
}

function riskSlices(dist: RiskBucketRow[]): DonutSlice[] {
  const by = new Map(dist.map((d) => [d.level, d.count]));
  return RISK_LEVELS.map((l) => ({ label: l.label, value: by.get(l.key) ?? 0, color: l.color })).filter((s) => s.value > 0);
}

/** Group the flat hot-path series into a filled per-path day series of totals. */
function pathSeries(series: HotPathTrendPoint[], path: string, days: number): number[] {
  const bins: DayBin[] = series
    .filter((p) => p.path === path)
    .map((p) => ({ day: p.day, reviews: 0, critical: p.critical, major: p.major, minor: 0, nit: 0 }));
  // Reuse buildDaySeries to fill gaps; total = critical + major carried in the bin.
  return buildDaySeries(bins, Math.min(days, 30)).map((b) => b.critical + b.major);
}

export function TrendsPage() {
  const [params, setParams] = useSearchParams();
  const days = normalizeDays(params.get("days"));
  const query = useTrends(days);
  const setDays = (d: number) => {
    const next = new URLSearchParams(params);
    next.set("days", String(d));
    setParams(next);
  };

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Trends" }]} />
      <PageHeader
        title="Trends"
        subtitle="Org-wide review activity, risk distribution, and which paths are heating up over time."
        right={<DaysPicker days={days} onChange={setDays} />}
      />

      <QueryBoundary query={query} loadingLabel="Loading trends…">
        {(data) => {
          const series = orgDaySeries(data.activity, days);
          const totalReviews = series.reduce((n, b) => n + b.reviews, 0);
          const totalFindings = series.reduce((n, b) => n + b.critical + b.major + b.minor + b.nit, 0);
          const totalCritical = series.reduce((n, b) => n + b.critical, 0);
          const slices = riskSlices(data.riskDistribution);

          return (
            <>
              <div className="grid three" style={{ marginBottom: 16 }}>
                <Metric label={`Reviews · ${days}d`} value={totalReviews.toLocaleString()} />
                <Metric label={`Findings · ${days}d`} value={totalFindings.toLocaleString()} />
                <Metric label={`Critical · ${days}d`} value={totalCritical.toLocaleString()} tone={totalCritical > 0 ? "danger" : "neutral"} />
              </div>

              <Card title="Activity over time" subtitle={`Reviews and findings by severity, last ${Math.min(days, 30)} days`} bodyClass="chart">
                <div className="activity-chart-frame">
                  <StackedSeverityBar series={series} hrefForSeverity={(s) => `/findings?severity=${s}`} />
                </div>
              </Card>

              <div className="grid two" style={{ marginTop: 16 }}>
                <Card title="Risk distribution" subtitle={`Reviews by risk level · last ${days} days`}>
                  {slices.length === 0 ? (
                    <EmptyState title="No reviews yet" hint="Risk levels appear once reviews run in this window." />
                  ) : (
                    <Donut slices={slices} size={130} />
                  )}
                </Card>

                <Card title="Hot paths over time" subtitle={`Top paths by critical + major findings · last ${Math.min(days, 30)} days`} bodyClass="flush">
                  {data.hotPaths.length === 0 ? (
                    <EmptyState title="No hot paths" hint="Paths appear once critical or major findings land." />
                  ) : (
                    <div className="hotpath-trends">
                      {data.hotPaths.map((p) => {
                        const severe = p.critical + p.major;
                        return (
                          <div className="hotpath-row" key={p.path}>
                            <span className="path mono" title={p.path}>
                              {p.path}
                            </span>
                            <LineSpark
                              values={pathSeries(data.hotPathSeries, p.path, days)}
                              color={p.critical > 0 ? "var(--sev-crit)" : "var(--sev-major)"}
                              width={140}
                              height={26}
                              title={`${p.path} · ${severe} severe findings`}
                            />
                            <span className="num">{severe}</span>
                          </div>
                        );
                      })}
                      <div className="hotpath-foot">
                        <span className="hint">Line traces critical + major findings per day. Higher = more friction on that path.</span>
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
