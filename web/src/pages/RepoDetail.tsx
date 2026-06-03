import { Link, useParams } from "react-router-dom";
import { useRepoDetail } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { ApprovalBadge, RiskBadge } from "../components/badges";
import { Donut, Hbar, RiskLine, StackedSeverityBar } from "../components/charts";
import { EmptyState, QueryBoundary } from "../components/states";
import { GithubIcon } from "../components/icons";
import { buildDaySeries, pluralize, relativeTime, toDayBins } from "../lib/format";
import type { IssueRow, RecentPRRow } from "../api/types";

function RecentPRs({ owner, repo, prs }: { owner: string; repo: string; prs: RecentPRRow[] }) {
  if (prs.length === 0) {
    return <EmptyState title="No reviews recorded yet" hint="Open a PR to get one." />;
  }
  return (
    <div className="tl">
      {prs.map((pr) => {
        const worst = (pr.worst_severity ?? "").toLowerCase();
        const sevCls =
          worst === "critical"
            ? "sev-critical"
            : worst === "major"
              ? "sev-major"
              : worst === "minor"
                ? "sev-minor"
                : pr.latest_approval === "approve"
                  ? "approve"
                  : "";
        return (
          <div className={`tl-item ${sevCls}`} key={pr.number}>
            <div className="when">{relativeTime(pr.latest_at)}</div>
            <div className="dot" />
            <div className="body">
              <div className="row1">
                <Link className="title" to={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr/${pr.number}`}>
                  {pr.title ?? `#${pr.number}`}
                </Link>
                <span className="mono muted">#{pr.number}</span>
              </div>
              <div className="row2">
                <RiskBadge level={pr.latest_risk_level} score={pr.latest_risk_score} />
                <ApprovalBadge approval={pr.latest_approval} />
                {pr.total_findings > 0 ? (
                  <span className="chip neutral tnum">
                    {pr.total_findings} {pluralize(pr.total_findings, "finding")}
                  </span>
                ) : (
                  <span className="chip muted uppercase">clean</span>
                )}
                {pr.review_count > 1 ? (
                  <span className="chip muted uppercase" title={`${pr.review_count} review iterations`}>
                    {pr.review_count}× reviews
                  </span>
                ) : null}
                {pr.author ? <span className="mono author">@{pr.author}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentIssues({ issues }: { issues: IssueRow[] }) {
  if (issues.length === 0) {
    return <EmptyState title="No issue activity yet" hint="The bot hasn't triaged or replied on an issue in this repo." />;
  }
  return (
    <div className="tl">
      {issues.map((iss) => {
        const when = iss.last_action_at ?? iss.first_seen_at;
        return (
          <div className="tl-item" key={iss.number}>
            <div className="when">{relativeTime(when)}</div>
            <div className="dot" />
            <div className="body">
              <div className="row1">
                <span className="title">{iss.title ?? `#${iss.number}`}</span>
                <span className="mono muted">#{iss.number}</span>
              </div>
              <div className="row2">
                {iss.state ? <span className={`chip ${iss.state === "open" ? "good" : "muted"} uppercase`}>{iss.state}</span> : null}
                {iss.last_action_kind ? (
                  <span className="chip neutral uppercase">{iss.last_action_kind.replace(/_/g, " ")}</span>
                ) : (
                  <span className="chip muted uppercase">no action</span>
                )}
                {iss.comment_count > 0 ? (
                  <span className="chip muted tnum">
                    {iss.comment_count} {pluralize(iss.comment_count, "comment")}
                  </span>
                ) : null}
                {iss.author ? <span className="mono author">@{iss.author}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RepoDetailPage() {
  const params = useParams();
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const query = useRepoDetail(owner, repo);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Repos", to: "/" }, { label: `${owner}/${repo}` }]} />
      <QueryBoundary query={query} loadingLabel="Loading repo…">
        {(a) => {
          const activity = buildDaySeries(toDayBins(a.activity), 30);
          const findingsTotal = activity.reduce((n, d) => n + d.critical + d.major + d.minor + d.nit, 0);
          const activeDays = activity.filter((d) => d.reviews > 0).length;
          const latestPR = a.prs[0] ?? null;
          const hotPathsMax = Math.max(1, ...a.hotPaths.map((p) => p.total));

          const approveN = a.approvalMix.find((m) => (m.approval ?? "").toLowerCase() === "approve")?.count ?? 0;
          const changesN = a.approvalMix.find((m) => (m.approval ?? "").toLowerCase() === "request_changes")?.count ?? 0;
          const commentN =
            a.approvalMix.find((m) => ["comment", "commented", ""].includes((m.approval ?? "").toLowerCase()))?.count ?? 0;
          const approvalTotal = approveN + changesN + commentN;

          return (
            <>
              <PageHeader
                title={`${owner}/${repo}`}
                subtitle={
                  latestPR
                    ? `Last review ${relativeTime(latestPR.latest_at)} · ${latestPR.total_findings} ${pluralize(latestPR.total_findings, "finding")}`
                    : "No reviews yet"
                }
                right={
                  <>
                    {latestPR ? <RiskBadge level={latestPR.latest_risk_level} score={latestPR.latest_risk_score} /> : null}
                    <a
                      href={`https://github.com/${owner}/${repo}`}
                      className="btn btn-ghost"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <GithubIcon />
                      Open in GitHub
                    </a>
                  </>
                }
              />

              <div className="grid hero" style={{ marginBottom: 16 }}>
                <Card
                  title="Findings · last 30 days"
                  subtitle={`${findingsTotal} across ${activeDays} active days`}
                  bodyClass="chart"
                >
                  <StackedSeverityBar series={activity} />
                </Card>
                <div className="grid stack">
                  <Card title="Risk score · 90d" subtitle={`${a.sparkline.length} ${pluralize(a.sparkline.length, "review")}`} bodyClass="chart">
                    <RiskLine points={a.sparkline} />
                  </Card>
                  <Card title="Approval mix · 30d">
                    {approvalTotal === 0 ? (
                      <EmptyState title="No reviews yet" hint="Approval ratio will appear after the first review." />
                    ) : (
                      <Donut
                        slices={[
                          { label: "Changes requested", value: changesN, color: "#fb6d82" },
                          { label: "Commented", value: commentN, color: "#9aa0b2" },
                          { label: "Approved", value: approveN, color: "#4ade80" },
                        ]}
                      />
                    )}
                  </Card>
                </div>
              </div>

              <div className="grid two" style={{ marginBottom: 16 }}>
                <Card title="Hot paths" subtitle="Critical + major · last 90 days" bodyClass="flush">
                  {a.hotPaths.length === 0 ? (
                    <EmptyState title="No hot paths" hint="No critical or major findings in the last 90 days." />
                  ) : (
                    a.hotPaths.map((p) => (
                      <Hbar key={p.path} label={p.path} critical={p.critical} major={p.major} total={p.total} max={hotPathsMax} />
                    ))
                  )}
                </Card>
                <Card title="Top firing rules" subtitle="All time" bodyClass="flush">
                  {a.topRules.length === 0 ? (
                    <EmptyState title="No rule hits" hint="Pattern rules haven't matched anything here yet." />
                  ) : (
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Rule</th>
                          <th>Source</th>
                          <th className="num">Hits</th>
                          <th className="right">Example</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.topRules.map((r, i) => (
                          <tr key={i}>
                            <td className="mono">{r.rule_name}</td>
                            <td className="muted">{r.source}</td>
                            <td className="num strong">{r.hits}</td>
                            <td className="right">
                              {r.example_pr ? (
                                <Link
                                  className="link mono"
                                  to={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr/${r.example_pr}`}
                                >
                                  #{r.example_pr}
                                </Link>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>

              <Card title="Recent PRs" subtitle={`Latest ${a.prs.length} · grouped by PR`} bodyClass="flush">
                <RecentPRs owner={owner} repo={repo} prs={a.prs} />
              </Card>

              <div style={{ marginTop: 16 }}>
                <Card
                  title="Recent issues"
                  subtitle={a.issues.length > 0 ? `${a.issues.length} tracked · DiffSentry actions across each thread` : "Issue activity will appear once the bot triages or replies on one"}
                  bodyClass="flush"
                >
                  <RecentIssues issues={a.issues} />
                </Card>
              </div>

              <div className="grid two" style={{ marginTop: 16 }}>
                <Card title={`Learnings (${a.learnings.length})`} subtitle="From @bot learn" bodyClass="flush">
                  {a.learnings.length === 0 ? (
                    <EmptyState title="No learnings yet" hint="Use @bot learn … on a PR to teach the reviewer." />
                  ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 420, overflow: "auto" }}>
                      {a.learnings.map((l) => (
                        <li
                          key={l.id}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "68px 1fr",
                            gap: 12,
                            padding: "10px 14px",
                            borderBottom: "1px solid var(--line-soft)",
                            fontSize: 13,
                            alignItems: "start",
                          }}
                        >
                          <span className="mono muted" style={{ fontSize: 10.5, paddingTop: 2 }}>
                            {relativeTime(l.createdAt)}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            {l.path ? (
                              <div className="mono muted" style={{ fontSize: 11, marginBottom: 3 }}>
                                {l.path}
                              </div>
                            ) : null}
                            <div style={{ color: "var(--text-1)", wordBreak: "break-word" }}>{l.content}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card
                  title=".diffsentry.yaml"
                  subtitle={a.config === null ? "Default branch · repo defaults" : "Default branch · enforced for all PRs"}
                  right={
                    <Link
                      className="btn btn-ghost"
                      to={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/config`}
                    >
                      Edit
                    </Link>
                  }
                >
                  {a.config === null ? (
                    <EmptyState title="Using defaults" hint="No .diffsentry.yaml on the default branch." />
                  ) : (
                    <pre
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        color: "var(--text-1)",
                        background: "var(--bg-deep)",
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        padding: 12,
                        maxHeight: 320,
                        overflow: "auto",
                        margin: 0,
                        whiteSpace: "pre",
                      }}
                    >
                      {a.config}
                    </pre>
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
