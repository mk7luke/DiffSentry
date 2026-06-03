import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuthorAnalytics, useAuthorDetail } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { ApprovalBadge, RiskBadge } from "../components/badges";
import { Donut, Hbar, LineSpark } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { buildDaySeries, relativeTime, type DayBin } from "../lib/format";
import type { AuthorDayRow, AuthorStatRow } from "../api/types";

const DAYS_OPTIONS = [7, 30, 90] as const;

/** Window picker shared by the analytics pages — preserves other URL params. */
export function DaysPicker({
  days,
  onChange,
}: {
  days: number;
  onChange: (d: number) => void;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label="Time window">
      {DAYS_OPTIONS.map((d) => (
        <button
          key={d}
          type="button"
          className={`seg${d === days ? " active" : ""}`}
          aria-pressed={d === days}
          onClick={() => onChange(d)}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

/** Build a filled N-day series of review volume for one author's sparkline. */
function authorVolume(series: AuthorDayRow[], author: string, days: number): number[] {
  const bins: DayBin[] = series
    .filter((r) => r.author === author)
    .map((r) => ({ day: r.day, reviews: r.reviews, critical: r.critical, major: r.major, minor: r.minor, nit: r.nit }));
  return buildDaySeries(bins, Math.min(days, 30)).map((b) => b.reviews);
}

type SortKey = "author" | "prs_reviewed" | "reviews" | "avg_risk" | "findings" | "findings_per_pr" | "critical" | "acceptance";

interface Derived extends AuthorStatRow {
  findings_per_pr: number;
  acceptance: number | null; // 0..1 or null when nothing triaged
}

function derive(a: AuthorStatRow): Derived {
  return {
    ...a,
    findings_per_pr: a.prs_reviewed > 0 ? a.findings / a.prs_reviewed : 0,
    acceptance: a.triaged > 0 ? a.accepted / a.triaged : null,
  };
}

function compare(a: Derived, b: Derived, key: SortKey): number {
  if (key === "author") return a.author.localeCompare(b.author);
  if (key === "acceptance") return (a.acceptance ?? -1) - (b.acceptance ?? -1);
  if (key === "avg_risk") return (a.avg_risk ?? -1) - (b.avg_risk ?? -1);
  return (a[key] as number) - (b[key] as number);
}

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const days = Number.parseInt(params.get("days") ?? "30", 10) || 30;
  const selected = params.get("author");
  const query = useAuthorAnalytics(days);

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "prs_reviewed", dir: "desc" });

  const setDays = (d: number) => {
    const next = new URLSearchParams(params);
    next.set("days", String(d));
    setParams(next);
  };
  const selectAuthor = (author: string | null) => {
    const next = new URLSearchParams(params);
    if (author) next.set("author", author);
    else next.delete("author");
    setParams(next);
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Leaderboard" }]} />
      <PageHeader
        title="Author leaderboard"
        subtitle="Review activity by PR author — a view of where review effort lands across the team, not a scoreboard."
        right={<DaysPicker days={days} onChange={setDays} />}
      />

      <QueryBoundary query={query} loadingLabel="Loading leaderboard…">
        {(data) => {
          const sorted = data.authors.map(derive).sort((a, b) => compare(a, b, sort.key));
          if (sort.dir === "desc") sorted.reverse();
          const rows = sorted;

          const totalPRs = data.authors.reduce((n, a) => n + a.prs_reviewed, 0);
          const totalFindings = data.authors.reduce((n, a) => n + a.findings, 0);
          const totalTriaged = data.authors.reduce((n, a) => n + a.triaged, 0);
          const totalAccepted = data.authors.reduce((n, a) => n + a.accepted, 0);
          const acceptancePct = totalTriaged > 0 ? Math.round((totalAccepted / totalTriaged) * 100) : null;

          const Th = ({ k, label, cls }: { k: SortKey; label: string; cls?: string }) => (
            <th
              className={`sortable${cls ? " " + cls : ""}${sort.key === k ? " sorted" : ""}`}
              onClick={() => toggleSort(k)}
              aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
            >
              {label}
              <span className="sort-caret">{sort.key === k ? (sort.dir === "desc" ? " ▾" : " ▴") : ""}</span>
            </th>
          );

          return (
            <>
              <div className="grid three" style={{ marginBottom: 16 }}>
                <Metric label={`PRs reviewed · ${days}d`} value={totalPRs.toLocaleString()} />
                <Metric label={`Findings raised · ${days}d`} value={totalFindings.toLocaleString()} />
                <Metric
                  label="Acceptance rate"
                  value={acceptancePct == null ? "—" : `${acceptancePct}%`}
                  foot={acceptancePct == null ? "no findings triaged yet" : `${totalAccepted} of ${totalTriaged} triaged kept`}
                />
              </div>

              <Card
                title="By author"
                subtitle={`${data.authors.length} author${data.authors.length === 1 ? "" : "s"} · click a row to drill in · click a column to sort`}
                bodyClass="flush"
              >
                {data.authors.length === 0 ? (
                  <EmptyState title="No review activity yet" hint="Author stats appear once PRs are reviewed in this window." />
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <Th k="author" label="Author" />
                        <Th k="prs_reviewed" label="PRs" cls="num" />
                        <Th k="reviews" label="Reviews" cls="num" />
                        <Th k="avg_risk" label="Avg risk" cls="num" />
                        <Th k="findings" label="Findings" cls="num" />
                        <Th k="findings_per_pr" label="Per PR" cls="num" />
                        <Th k="critical" label="Critical" cls="num" />
                        <Th k="acceptance" label="Accepted" cls="num" />
                        <th className="right">Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => (
                        <tr
                          key={a.author}
                          className={`clickable${a.author === selected ? " selected" : ""}`}
                          onClick={() => selectAuthor(a.author === selected ? null : a.author)}
                        >
                          <td className="strong">{a.author}</td>
                          <td className="num">{a.prs_reviewed}</td>
                          <td className="num muted">{a.reviews}</td>
                          <td className="num">{a.avg_risk == null ? "—" : Math.round(a.avg_risk)}</td>
                          <td className="num">{a.findings}</td>
                          <td className="num muted">{a.findings_per_pr.toFixed(1)}</td>
                          <td className={`num ${a.critical > 0 ? "crit" : "zero"}`}>{a.critical}</td>
                          <td className="num">{a.acceptance == null ? "—" : `${Math.round(a.acceptance * 100)}%`}</td>
                          <td className="right" style={{ width: 130 }}>
                            <LineSpark
                              values={authorVolume(data.series, a.author, days)}
                              title={`${a.author} · reviews/day`}
                              width={120}
                              height={26}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              {selected ? <AuthorDrilldown author={selected} days={days} onClose={() => selectAuthor(null)} /> : null}
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

function AuthorDrilldown({ author, days, onClose }: { author: string; days: number; onClose: () => void }) {
  const query = useAuthorDetail(author, days);
  return (
    <div style={{ marginTop: 18 }}>
      <Card
        title={`@${author}`}
        subtitle={`Last ${days} days`}
        right={
          <button type="button" className="btn btn-link" onClick={onClose}>
            close
          </button>
        }
      >
        <QueryBoundary query={query} loadingLabel="Loading author…">
          {(data) => {
            const stat = data.stat;
            const volume = buildDaySeries(
              data.series.map((r) => ({ day: r.day, reviews: r.reviews, critical: r.critical, major: r.major, minor: r.minor, nit: r.nit })),
              Math.min(days, 30),
            );
            const findingsByDay = volume.map((b) => b.critical + b.major + b.minor + b.nit);
            const reviewsByDay = volume.map((b) => b.reviews);
            const pathMax = Math.max(1, ...data.hotPaths.map((p) => p.total));
            const slices = stat
              ? [
                  { label: "Critical", value: stat.critical, color: "var(--sev-crit)" },
                  { label: "Major", value: stat.major, color: "var(--sev-major)" },
                  { label: "Minor", value: stat.minor, color: "var(--sev-minor)" },
                  { label: "Nit", value: stat.nit, color: "var(--sev-nit)" },
                ]
              : [];
            const acc = stat && stat.triaged > 0 ? Math.round((stat.accepted / stat.triaged) * 100) : null;
            return (
              <div className="drill-grid">
                <div className="drill-spark">
                  <div className="drill-stat-row">
                    <Metric label="PRs reviewed" value={stat?.prs_reviewed ?? 0} />
                    <Metric label="Avg risk" value={stat?.avg_risk == null ? "—" : Math.round(stat.avg_risk)} />
                    <Metric label="Findings / PR" value={stat && stat.prs_reviewed > 0 ? (stat.findings / stat.prs_reviewed).toFixed(1) : "0.0"} />
                    <Metric label="Acceptance" value={acc == null ? "—" : `${acc}%`} />
                  </div>
                  <div className="drill-trends">
                    <div>
                      <div className="drill-trend-label">Reviews / day</div>
                      <LineSpark values={reviewsByDay} width={320} height={44} color="var(--accent)" />
                    </div>
                    <div>
                      <div className="drill-trend-label">Findings / day</div>
                      <LineSpark values={findingsByDay} width={320} height={44} color="var(--sev-major)" />
                    </div>
                  </div>
                </div>
                <div className="drill-donut">
                  <div className="drill-trend-label">Severity mix</div>
                  {stat && stat.findings > 0 ? (
                    <Donut slices={slices} size={110} />
                  ) : (
                    <EmptyState title="No findings" hint="Clean reviews in this window." />
                  )}
                </div>
                <div className="drill-paths">
                  <div className="drill-trend-label">Hottest paths</div>
                  {data.hotPaths.length === 0 ? (
                    <EmptyState title="No hot paths" hint="No critical/major findings landed on a single path." />
                  ) : (
                    <div>
                      {data.hotPaths.map((p) => (
                        <Hbar key={p.path} label={p.path} critical={p.critical} major={p.major} total={p.total} max={pathMax} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="drill-prs">
                  <div className="drill-trend-label">Recent PRs</div>
                  {data.prs.length === 0 ? (
                    <EmptyState title="No PRs" hint="No reviewed PRs for this author in the window." />
                  ) : (
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>PR</th>
                          <th>Repo</th>
                          <th>Risk</th>
                          <th>Outcome</th>
                          <th className="num">Findings</th>
                          <th className="right">Latest</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.prs.map((pr) => (
                          <tr key={`${pr.owner}/${pr.repo}#${pr.number}`}>
                            <td className="mono">
                              <Link className="link" to={`/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pr/${pr.number}`}>
                                #{pr.number}
                              </Link>
                            </td>
                            <td className="mono muted">
                              <Link className="link" to={`/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}`}>
                                {pr.owner}/{pr.repo}
                              </Link>
                            </td>
                            <td>
                              <RiskBadge level={pr.latest_risk_level} score={pr.latest_risk_score} />
                            </td>
                            <td>
                              <ApprovalBadge approval={pr.latest_approval} />
                            </td>
                            <td className="num">{pr.total_findings}</td>
                            <td className="right muted">{relativeTime(pr.latest_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            );
          }}
        </QueryBoundary>
      </Card>
    </div>
  );
}
