import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { usePRDetail } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { ActionBar } from "../components/ActionBar";
import { ApprovalBadge, RiskBadge, SeverityBadge, TriageBadge } from "../components/badges";
import { TriageMenu } from "../components/TriageControls";
import { EmptyState, QueryBoundary } from "../components/states";
import { Markdown } from "../components/Markdown";
import { useEventStream, type StreamEnvelope } from "../realtime/useEventStream";
import { pluralize, relativeTime } from "../lib/format";
import type { PRReviewRow } from "../api/types";

function LatestReview({ latest }: { latest: PRReviewRow }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <RiskBadge level={latest.risk_level} score={latest.risk_score} />
        <span className="chip neutral uppercase">{latest.profile ?? "—"}</span>
        <ApprovalBadge approval={latest.approval} />
      </div>
      <dl className="kv">
        <div>
          <dt>Files processed</dt>
          <dd>{latest.files_processed ?? 0}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{latest.finding_count}</dd>
        </div>
        <div>
          <dt>Skipped · similar</dt>
          <dd>{latest.files_skipped_similar ?? 0}</dd>
        </div>
        <div>
          <dt>Skipped · trivial</dt>
          <dd>{latest.files_skipped_trivial ?? 0}</dd>
        </div>
      </dl>
      {latest.summary ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div className="chip muted uppercase">Summary</div>
            <button type="button" className="btn btn-link" style={{ fontSize: 11 }} onClick={() => setShowRaw((v) => !v)}>
              toggle raw
            </button>
          </div>
          {showRaw ? (
            <pre
              className="mono"
              style={{ fontSize: 11.5, whiteSpace: "pre-wrap", color: "var(--text-1)", lineHeight: 1.55, maxHeight: 320, overflow: "auto", margin: 0 }}
            >
              {latest.summary}
            </pre>
          ) : (
            <Markdown source={latest.summary} maxHeight={320} />
          )}
        </div>
      ) : null}
    </>
  );
}

export function PRDetailPage() {
  const params = useParams();
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const number = Number.parseInt(params.number ?? "", 10);
  const query = usePRDetail(owner, repo, number);
  const qc = useQueryClient();

  // Live updates: when a review for *this* PR finishes/fails or an action is
  // performed, refetch the detail so findings/events reflect it without a
  // manual refresh.
  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      const p = env.payload as { owner?: string; repo?: string; number?: number };
      if (p.owner === owner && p.repo === repo && p.number === number) {
        void qc.invalidateQueries({ queryKey: ["pr", owner, repo, number] });
      }
    },
    [qc, owner, repo, number],
  );
  useEventStream(onEvent);

  return (
    <>
      <Breadcrumbs
        crumbs={[
          { label: "Repos", to: "/overview" },
          { label: `${owner}/${repo}`, to: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` },
          { label: `#${number}` },
        ]}
      />
      <QueryBoundary query={query} loadingLabel="Loading PR…">
        {(a) => {
          const latestReviewId = a.latest?.id ?? null;
          return (
            <>
              <PageHeader
                title={a.pr?.title ?? `PR #${a.number}`}
                subtitle={
                  <>
                    <span className="mono" style={{ color: "var(--text-2)" }}>
                      {owner}/{repo}
                    </span>{" "}
                    <span style={{ color: "var(--text-4)" }}>·</span> <span className="mono">#{a.number}</span>
                    {a.pr?.author ? (
                      <>
                        {" "}
                        <span style={{ color: "var(--text-4)" }}>·</span>{" "}
                        <span className="mono" style={{ color: "var(--accent-bright)" }}>
                          @{a.pr.author}
                        </span>
                      </>
                    ) : null}{" "}
                    {a.pr?.state ? <span className={`chip ${a.pr.state === "open" ? "good" : "muted"} uppercase`}>{a.pr.state}</span> : null}
                  </>
                }
              />

              <ActionBar owner={owner} repo={repo} number={a.number} variant="pr" />

              <div className="grid stack">
                {a.latest ? (
                  <Card title="Latest review" subtitle={`${(a.latest.sha ?? "").slice(0, 7)} · ${relativeTime(a.latest.created_at)}`}>
                    <LatestReview latest={a.latest} />
                  </Card>
                ) : (
                  <Card>
                    <EmptyState title="No reviews for this PR" hint="Trigger a review to get started." />
                  </Card>
                )}

                <Card
                  title="Findings"
                  subtitle={
                    a.findings.length > 0
                      ? `${a.findings.length} across ${a.reviews.length} ${pluralize(a.reviews.length, "review")}`
                      : undefined
                  }
                  bodyClass="flush"
                >
                  {a.findings.length === 0 ? (
                    <EmptyState title="No findings" hint="Nothing flagged across any review of this PR." />
                  ) : (
                    <table className="tbl rail">
                      <thead>
                        <tr>
                          <th>Severity</th>
                          <th>Location</th>
                          <th>Title</th>
                          <th>Review</th>
                          <th>Source</th>
                          <th>Triage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.findings.map((f) => {
                          const isLatest = latestReviewId !== null && f.review_id === latestReviewId;
                          const sha = (f.review_sha ?? "").slice(0, 7);
                          return (
                            <tr key={f.id} data-sev={(f.severity ?? "").toLowerCase()}>
                              <td data-label="Severity">
                                <SeverityBadge severity={f.severity} />
                              </td>
                              <td className="mono" data-label="Location">
                                {f.path ?? ""}
                                {f.line ? <span className="line-num">:{f.line}</span> : null}
                              </td>
                              <td>
                                <div className="strong">{f.title ?? "—"}</div>
                                {f.body ? (
                                  <details style={{ marginTop: 4 }}>
                                    <summary style={{ fontSize: 11, color: "var(--text-3)", cursor: "pointer" }}>Show rendered body</summary>
                                    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--line)" }}>
                                      <Markdown source={f.body.slice(0, 4000)} />
                                    </div>
                                  </details>
                                ) : null}
                              </td>
                              <td className="nowrap" data-label="Review">
                                <span className="mono" style={{ color: isLatest ? "var(--accent-bright)" : "var(--text-3)" }} title={f.review_at}>
                                  {sha || "—"}
                                </span>
                                {isLatest ? (
                                  <span className="chip muted uppercase" style={{ marginLeft: 4 }}>
                                    latest
                                  </span>
                                ) : (
                                  <span className="muted" style={{ fontSize: 10.5, marginLeft: 4 }}>
                                    {relativeTime(f.review_at)}
                                  </span>
                                )}
                              </td>
                              <td className="muted" data-label="Source">{f.source ?? "—"}</td>
                              <td data-label="Triage">
                                <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <TriageBadge row={f} />
                                  <TriageMenu target={{ kind: "single", id: f.id }} compact />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>

                {a.reviews.length > 1 ? (
                  <Card title={`All reviews (${a.reviews.length})`} bodyClass="flush">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th className="right">When</th>
                          <th>SHA</th>
                          <th>Profile</th>
                          <th>Risk</th>
                          <th className="num">Findings</th>
                          <th>Approval</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.reviews.map((rv) => (
                          <tr key={rv.id}>
                            <td className="right muted" data-label="When">{relativeTime(rv.created_at)}</td>
                            <td className="mono" style={{ color: "var(--accent-bright)" }} data-label="SHA">
                              {(rv.sha ?? "").slice(0, 7)}
                            </td>
                            <td className="muted" data-label="Profile">{rv.profile ?? "—"}</td>
                            <td data-label="Risk">
                              <RiskBadge level={rv.risk_level} score={rv.risk_score} />
                            </td>
                            <td className={`num ${rv.finding_count > 0 ? "strong" : "zero"}`} data-label="Findings">{rv.finding_count}</td>
                            <td data-label="Approval">
                              <ApprovalBadge approval={rv.approval} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                ) : null}

                <Card title="Events" subtitle={`${a.events.length} most recent`} bodyClass="flush">
                  {a.events.length === 0 ? (
                    <EmptyState title="No events" hint="PR hooks haven't fired yet." />
                  ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 380, overflow: "auto" }}>
                      {a.events.map((ev) => (
                        <li
                          key={ev.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "7px 14px",
                            borderBottom: "1px solid var(--line-soft)",
                            fontSize: 12.5,
                          }}
                        >
                          <span className="mono" style={{ color: "var(--text-1)" }}>
                            {ev.kind}
                          </span>
                          <span className="mono muted" style={{ fontSize: 10.5 }}>
                            {relativeTime(ev.ts)}
                          </span>
                        </li>
                      ))}
                    </ul>
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
