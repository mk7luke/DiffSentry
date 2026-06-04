import { Link } from "react-router-dom";
import { useHealth } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { GlobalSettingsControls } from "../components/SettingsControls";
import { RoleBadge } from "../components/badges";
import { EmptyState, QueryBoundary } from "../components/states";
import type { Capabilities } from "../api/types";
import { formatBytes, relativeTime } from "../lib/format";

const CAPABILITY_LABELS: { key: keyof Capabilities; label: string }[] = [
  { key: "viewDashboard", label: "View dashboard" },
  { key: "triageFindings", label: "Triage findings" },
  { key: "triggerReview", label: "Trigger reviews" },
  { key: "manageLearnings", label: "Manage learnings" },
  { key: "manageConfig", label: "Manage config" },
  { key: "manageRoles", label: "Manage roles" },
  { key: "viewAudit", label: "View audit log" },
  { key: "manageTokens", label: "Manage API tokens" },
];

export function SettingsPage() {
  const query = useHealth();
  const auth = useAuth();
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Settings" }]} />
      <PageHeader
        title="Settings & health"
        subtitle="Operator controls, persistence stats, recent warnings, and the signed-in session."
        right={
          <Link to="/settings/diagnostics" className="btn btn-ghost btn-sm">
            Diagnostics & setup →
          </Link>
        }
      />

      {/* Operator controls — admin only. The server enforces requireRole('admin')
          on every settings endpoint; this gate just avoids fetching/showing them
          to non-admins (who would otherwise get a 403). */}
      {auth.capabilities.manageConfig ? (
        <div style={{ marginBottom: 16 }}>
          <GlobalSettingsControls />
        </div>
      ) : null}

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
                <Card title="Session & access">
                  <dl className="kv">
                    <div>
                      <dt>Signed in as</dt>
                      <dd className="mono">{auth.login ? `@${auth.login}` : "—"}</dd>
                    </div>
                    <div>
                      <dt>Role</dt>
                      <dd>{auth.role ? <RoleBadge role={auth.role} /> : "—"}</dd>
                    </div>
                    <div>
                      <dt>OAuth</dt>
                      <dd>{auth.authEnabled ? "enabled" : "disabled (local — admin)"}</dd>
                    </div>
                  </dl>
                  <div className="caps">
                    {CAPABILITY_LABELS.map(({ key, label }) => (
                      <div key={key} className={`cap${auth.capabilities[key] ? " on" : ""}`}>
                        <span className="cap-dot" aria-hidden="true" />
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
                    Roles resolve from the roles table, then the{" "}
                    <span className="mono">DASHBOARD_ADMIN_LOGINS</span> /{" "}
                    <span className="mono">DASHBOARD_AUTHOR_LOGINS</span> env allowlists, then viewer.
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
