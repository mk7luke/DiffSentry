import { useState } from "react";
import { Link } from "react-router-dom";
import { useRepos } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, Metric, PageHeader } from "../components/primitives";
import { MiniSparkbar, StackedSeverityBar } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { buildDaySeries, groupActivityByRepo, relativeTime, repoHealth } from "../lib/format";
import type { RepoOverviewRow } from "../api/types";

type SortKey = "last_review" | "critical_7d" | "findings_7d" | "prs_reviewed" | "repo";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "last_review", label: "Last review" },
  { key: "critical_7d", label: "Critical" },
  { key: "findings_7d", label: "Findings" },
  { key: "prs_reviewed", label: "PRs" },
  { key: "repo", label: "Name" },
];

function sortRepos(rows: RepoOverviewRow[], key: SortKey): RepoOverviewRow[] {
  const cmp: Record<SortKey, (a: RepoOverviewRow, b: RepoOverviewRow) => number> = {
    repo: (a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
    prs_reviewed: (a, b) => b.prs_reviewed - a.prs_reviewed,
    findings_7d: (a, b) => b.findings_7d - a.findings_7d,
    critical_7d: (a, b) => b.critical_7d - a.critical_7d,
    last_review: (a, b) => (b.last_review ?? "").localeCompare(a.last_review ?? ""),
  };
  return [...rows].sort(cmp[key]);
}

export function OverviewPage() {
  const query = useRepos();
  const [sort, setSort] = useState<SortKey>("last_review");
  const [showInactive, setShowInactive] = useState(false);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Repos" }]} />
      <QueryBoundary query={query} loadingLabel="Loading repos…">
        {(data) => {
          const rows = sortRepos(data.repos, sort);
          const activityByRepo = groupActivityByRepo(data.activity);
          const visibleRows = showInactive ? rows : rows.filter((r) => r.prs_reviewed > 0);
          const totals = rows.reduce(
            (acc, r) => {
              acc.repos += 1;
              if (r.prs_reviewed > 0) acc.active += 1;
              acc.prs += r.prs_reviewed;
              acc.findings += r.findings_7d;
              acc.critical += r.critical_7d;
              return acc;
            },
            { repos: 0, active: 0, prs: 0, findings: 0, critical: 0 },
          );

          const aggregate = buildDaySeries([], 14);
          for (const bins of activityByRepo.values()) {
            for (const b of bins) {
              const i = aggregate.findIndex((a) => a.day === b.day);
              if (i >= 0) {
                aggregate[i].reviews += b.reviews;
                aggregate[i].critical += b.critical;
                aggregate[i].major += b.major;
                aggregate[i].minor += b.minor;
                aggregate[i].nit += b.nit;
              }
            }
          }
          const aggTotal = aggregate.reduce((n, d) => n + d.critical + d.major + d.minor + d.nit, 0);
          const inactiveCount = totals.repos - totals.active;

          return (
            <>
              <PageHeader
                title="Overview"
                subtitle={`${totals.active} active · ${totals.repos} installed · rolling 7-day stats`}
                right={
                  <button className="btn btn-ghost" onClick={() => setShowInactive((v) => !v)}>
                    {showInactive ? `Hide inactive (${inactiveCount})` : `Show inactive (${inactiveCount})`}
                  </button>
                }
              />

              <div className="grid hero" style={{ marginBottom: 20 }}>
                <Card title="Activity · last 14 days" subtitle={`${aggTotal} findings across all repos`} bodyClass="chart">
                  <StackedSeverityBar series={aggregate} hrefForSeverity={(s) => `/findings?severity=${s}`} />
                </Card>
                <div className="grid stack">
                  <Metric
                    label="Critical · 7D"
                    value={totals.critical}
                    tone={totals.critical > 0 ? "danger" : undefined}
                    hero
                    foot={
                      totals.critical > 0 ? (
                        <Chip tone="danger" uppercase dot>
                          needs attention
                        </Chip>
                      ) : (
                        <Chip tone="good" uppercase dot>
                          clean
                        </Chip>
                      )
                    }
                  />
                  <div className="grid three" style={{ gap: 10 }}>
                    <Metric label="Active repos" value={totals.active} />
                    <Metric label="PRs reviewed" value={totals.prs} />
                    <Metric label="Findings · 7D" value={totals.findings} />
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 2px 12px" }}>
                <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.005em" }}>Repositories</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-3)" }}>
                  <span style={{ marginRight: 4 }}>Sort:</span>
                  {SORTS.map((s) => (
                    <button
                      key={s.key}
                      className="btn btn-link"
                      style={{ color: s.key === sort ? "var(--text)" : "var(--text-3)" }}
                      onClick={() => setSort(s.key)}
                    >
                      {s.label}
                      {s.key === sort ? <span style={{ color: "var(--accent-bright)" }}> ↓</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              {visibleRows.length === 0 ? (
                <Card>
                  <EmptyState
                    title={data.repos.length === 0 ? "No repos recorded yet" : "No repos with reviewed PRs yet"}
                    hint={
                      data.repos.length === 0
                        ? "Open a PR in an installed repo to populate the database."
                        : "Click “Show inactive” to see dormant installations."
                    }
                  />
                </Card>
              ) : (
                <div className="grid two">
                  {visibleRows.map((r) => {
                    const health = repoHealth(r.prs_reviewed, r.findings_7d, r.critical_7d);
                    const series = buildDaySeries(activityByRepo.get(`${r.owner}/${r.repo}`) ?? [], 14);
                    const idleCls = r.prs_reviewed === 0 ? " idle" : "";
                    return (
                      <Link
                        key={`${r.owner}/${r.repo}`}
                        className={`repo-card health-${health}${idleCls}`}
                        to={`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`}
                      >
                        <div>
                          <div className="title">
                            <span className="owner">{r.owner}/</span>
                            {r.repo}
                          </div>
                          <div className="meta">
                            <span className="stat">
                              <span className={`n${r.prs_reviewed === 0 ? " zero" : ""}`}>{r.prs_reviewed}</span> PRs reviewed
                            </span>
                            <span className="stat">
                              <span className={`n${r.findings_7d === 0 ? " zero" : ""}`}>{r.findings_7d}</span> findings · 7d
                            </span>
                            <span className="stat">
                              <span className={`n${r.critical_7d > 0 ? " crit" : " zero"}`}>{r.critical_7d}</span> critical · 7d
                            </span>
                          </div>
                        </div>
                        <div className="right">
                          <div className="when">{relativeTime(r.last_review) || "never"}</div>
                        </div>
                        <MiniSparkbar series={series} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
