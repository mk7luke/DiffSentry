import { Link } from "react-router-dom";
import { usePatterns } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { EmptyState, QueryBoundary } from "../components/states";
import { relativeTime } from "../lib/format";

export function PatternsPage() {
  const query = usePatterns();
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Patterns" }]} />
      <PageHeader title="Patterns" subtitle="Built-in and custom rule hits across every repo — what's firing, and how often." />
      <QueryBoundary query={query} loadingLabel="Loading patterns…">
        {(data) => {
          const rules = data.rules;
          const total = rules.reduce((n, r) => n + r.hits_total, 0);
          const last30 = rules.reduce((n, r) => n + r.hits_30d, 0);
          const distinct = new Set(rules.map((r) => r.rule_name)).size;
          return (
            <>
              <div className="grid three" style={{ marginBottom: 16 }}>
                <Metric label="Total hits" value={total.toLocaleString()} />
                <Metric label="Hits · 30D" value={last30.toLocaleString()} />
                <Metric label="Distinct rules" value={distinct} />
              </div>
              <Card title="Rule hits" subtitle={`${rules.length} rule/repo combinations · ranked by recent activity`} bodyClass="flush">
                {rules.length === 0 ? (
                  <EmptyState title="No pattern hits yet" hint="Built-in and custom rules populate this once reviews run." />
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Rule</th>
                        <th>Source</th>
                        <th>Repo</th>
                        <th className="num">Hits · 30d</th>
                        <th className="num">Hits · total</th>
                        <th className="right">Last hit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r, i) => (
                        <tr key={i}>
                          <td className="mono strong">{r.rule_name}</td>
                          <td className="muted" data-label="Source">{r.source}</td>
                          <td className="mono" data-label="Repo">
                            <Link className="link" to={`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`}>
                              {r.owner}/{r.repo}
                            </Link>
                          </td>
                          <td className={`num ${r.hits_30d > 0 ? "strong" : "zero"}`} data-label="Hits · 30d">{r.hits_30d}</td>
                          <td className="num" data-label="Hits · total">{r.hits_total}</td>
                          <td className="right muted" data-label="Last hit">{r.last_hit ? relativeTime(r.last_hit) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
