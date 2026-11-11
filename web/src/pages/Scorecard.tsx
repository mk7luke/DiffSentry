import { Link } from "react-router";
import { useScorecard } from "../api/hooks";
import type { ScorecardRow } from "../api/types";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { EmptyState, QueryBoundary } from "../components/states";
import { relativeTime } from "../lib/format";

const DAYS = 90;

/**
 * A rate off three samples reads as authority and isn't one, so it isn't shown
 * until there are enough judgements to mean something.
 */
const MIN_JUDGED_FOR_RATE = 5;

function confirmedRate(r: ScorecardRow): string {
  const judged = r.accepted + r.dismissed;
  if (judged < MIN_JUDGED_FOR_RATE) return "—";
  return `${Math.round((r.accepted / judged) * 100)}%`;
}

export function ScorecardPage() {
  const query = useScorecard(DAYS);
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Scorecard" }]} />
      <PageHeader
        title="Scorecard"
        subtitle={`Were the findings right? What humans did about everything raised in the last ${DAYS} days — plus what the review cache saved.`}
      />
      <QueryBoundary query={query} loadingLabel="Loading scorecard…">
        {(data) => {
          const rows = data.rows;
          const sum = (pick: (r: ScorecardRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
          const total = sum((r) => r.total);
          const accepted = sum((r) => r.accepted);
          const dismissed = sum((r) => r.dismissed);
          const judged = accepted + dismissed;
          return (
            <>
              <div className="grid four" style={{ marginBottom: 16 }}>
                <Metric label={`Findings · ${DAYS}D`} value={total.toLocaleString()} />
                <Metric label="Judged by a human" value={judged.toLocaleString()} />
                <Metric
                  label="Confirmed"
                  value={judged >= MIN_JUDGED_FOR_RATE ? `${Math.round((accepted / judged) * 100)}%` : "—"}
                />
                <Metric label="Cache hits" value={data.cache.hits.toLocaleString()} />
              </div>

              <Card
                title="Outcomes by source"
                subtitle={`${rows.length} source/severity buckets · 👍 and 👎 on a finding count here too`}
                bodyClass="flush"
              >
                {rows.length === 0 ? (
                  <EmptyState
                    title="Nothing to score yet"
                    hint="This fills in as reviews run and findings get accepted, dismissed or thumbed up/down."
                  />
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Repo</th>
                        <th>Source</th>
                        <th>Severity</th>
                        <th className="num">Raised</th>
                        <th className="num">Confirmed</th>
                        <th className="num">Dismissed</th>
                        <th className="num">Snoozed</th>
                        <th className="num">Unjudged</th>
                        <th className="right">Confirmed rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td className="mono cell-primary" data-label="Repo">
                            <Link className="link" to={`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`}>
                              {r.owner}/{r.repo}
                            </Link>
                          </td>
                          <td className="muted" data-label="Source">{r.source}</td>
                          <td data-label="Severity">{r.severity}</td>
                          <td className="num strong" data-label="Raised">{r.total}</td>
                          <td className={`num ${r.accepted > 0 ? "strong" : "zero"}`} data-label="Confirmed">{r.accepted}</td>
                          <td className={`num ${r.dismissed > 0 ? "strong" : "zero"}`} data-label="Dismissed">{r.dismissed}</td>
                          <td className={`num ${r.snoozed > 0 ? "" : "zero"}`} data-label="Snoozed">{r.snoozed}</td>
                          <td className="num muted" data-label="Unjudged">{r.untriaged}</td>
                          <td className="right" data-label="Confirmed rate">{confirmedRate(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card
                title="Review cache"
                subtitle="A diff reviewed twice — a rebase, a force-push back to a reviewed tree, a retried pass — costs one model call."
              >
                <div className="grid three">
                  <Metric label="Cached reviews" value={data.cache.rows.toLocaleString()} />
                  <Metric label="Model calls skipped" value={data.cache.hits.toLocaleString()} />
                  <Metric label="Oldest entry" value={data.cache.oldest ? relativeTime(data.cache.oldest) : "—"} />
                </div>
              </Card>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
