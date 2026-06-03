import { useHealth, useMe } from "../api/hooks";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { EmptyState, QueryBoundary } from "../components/states";
import { formatBytes, relativeTime } from "../lib/format";

export function SettingsPage() {
  const query = useHealth();
  const me = useMe();
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Settings" }]} />
      <PageHeader title="Settings & health" subtitle="Persistence stats, recent warnings, and the signed-in session." />
      <QueryBoundary query={query} loadingLabel="Loading health…">
        {(data) => {
          const c = data.counts;
          return (
            <>
              <div className="grid four" style={{ marginBottom: 16 }}>
                <Metric label="Repos" value={c.repos.toLocaleString()} />
                <Metric label="PRs" value={c.prs.toLocaleString()} />
                <Metric label="Reviews" value={c.reviews.toLocaleString()} />
                <Metric label="Findings" value={c.findings.toLocaleString()} />
              </div>
              <div className="grid two" style={{ marginBottom: 16 }}>
                <Card title="Database">
                  <dl className="kv">
                    <div>
                      <dt>Issues</dt>
                      <dd>{c.issues.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Events</dt>
                      <dd>{c.events.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Pattern hits</dt>
                      <dd>{c.pattern_hits.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>DB size</dt>
                      <dd>{formatBytes(c.db_bytes)}</dd>
                    </div>
                    <div>
                      <dt>Oldest review</dt>
                      <dd className="mono">{c.oldest_review ? c.oldest_review.slice(0, 10) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Newest review</dt>
                      <dd className="mono">{c.newest_review ? relativeTime(c.newest_review) : "—"}</dd>
                    </div>
                  </dl>
                </Card>
                <Card title="Session">
                  <dl className="kv">
                    <div>
                      <dt>Signed in as</dt>
                      <dd className="mono">{me.data ? `@${me.data.user.login}` : "—"}</dd>
                    </div>
                    <div>
                      <dt>Role</dt>
                      <dd>{me.data?.user.role ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>OAuth</dt>
                      <dd>{me.data ? (me.data.authEnabled ? "enabled" : "disabled (local)") : "—"}</dd>
                    </div>
                  </dl>
                  <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
                    Role-based access control arrives in W0.3 — every authenticated user is currently treated as admin.
                  </p>
                </Card>
              </div>
              <Card title="Recent warnings & errors" subtitle={`${data.logs.length} in the in-memory ring buffer`} bodyClass="flush">
                {data.logs.length === 0 ? (
                  <EmptyState title="No warnings or errors" hint="The warn/error log ring is empty — nothing to report." />
                ) : (
                  <div>
                    {[...data.logs].reverse().map((l, i) => (
                      <div className="logrow" key={i}>
                        <span className="ts">{relativeTime(l.ts)}</span>
                        <span className={`lvl ${l.level}`}>{l.level}</span>
                        <span className="msg">{l.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}
