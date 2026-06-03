import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAudit, useSetRole } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { RoleBadge } from "../components/badges";
import { EmptyState, LoadingState, QueryBoundary } from "../components/states";
import { ApiError } from "../api/client";
import type { Role } from "../api/types";
import { pluralize, relativeTime } from "../lib/format";

const PAGE = 100;
const ROLES: Role[] = ["viewer", "author", "admin"];

/** Admin-only screen: the audit trail + per-login role overrides. The Audit
 * nav link is already hidden for non-admins; this guard covers a direct visit
 * (and the server returns 403 regardless). */
export function AuditPage() {
  const { capabilities, isLoading } = useAuth();

  // Wait for /me before deciding — otherwise AuditContent would mount and fire
  // the (admin-only) /audit query before the role resolves.
  if (isLoading) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Audit log" }]} />
        <PageHeader title="Audit log" subtitle="Admin only." />
        <LoadingState label="Loading…" />
      </>
    );
  }

  if (!capabilities.viewAudit) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Audit log" }]} />
        <PageHeader title="Audit log" subtitle="Admin only." />
        <section className="card tone-danger">
          <div className="empty">
            <div className="mono" style={{ color: "var(--sev-crit)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
              403 · FORBIDDEN
            </div>
            <div className="title">You need the admin role to view the audit log.</div>
          </div>
        </section>
      </>
    );
  }

  return <AuditContent />;
}

function AuditContent() {
  const [params, setParams] = useSearchParams();
  const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);
  const action = params.get("action") ?? undefined;
  const actor = params.get("actor") ?? undefined;

  const query = useAudit({ action, actor, limit: PAGE, offset }, true);

  const setOffset = (o: number) => {
    const next = new URLSearchParams(params);
    if (o <= 0) next.delete("offset");
    else next.set("offset", String(o));
    setParams(next);
  };

  const setAction = (a: string) => {
    const next = new URLSearchParams(params);
    if (a) next.set("action", a);
    else next.delete("action");
    next.delete("offset");
    setParams(next);
  };

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Audit log" }]} />
      <PageHeader
        title="Audit log"
        subtitle="Every privileged action — who did what, when, and the result. Admin only."
      />

      <QueryBoundary query={query} loadingLabel="Loading audit log…">
        {(data) => (
          <>
            <RolesCard roles={data.roles} />

            <div style={{ marginTop: 16 }}>
              <Card
                title="Audit trail"
                subtitle={`${data.total.toLocaleString()} ${pluralize(data.total, "entry", "entries")}`}
                right={
                  data.actions.length > 0 ? (
                    <label className="field" style={{ marginBottom: 0 }}>
                      <select value={action ?? ""} onChange={(e) => setAction(e.target.value)}>
                        <option value="">all actions</option>
                        {data.actions.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null
                }
                bodyClass="flush"
              >
                {data.rows.length === 0 ? (
                  <EmptyState
                    title="No audit entries"
                    hint="Privileged actions (role changes, config edits, triggered reviews) will appear here."
                  />
                ) : (
                  <>
                    <table className="tbl rail">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Actor</th>
                          <th>Action</th>
                          <th>Target</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r) => (
                          <tr key={r.id}>
                            <td className="muted" title={r.ts}>
                              {relativeTime(r.ts)}
                            </td>
                            <td>
                              <span className="mono">{r.actor_login ?? "—"}</span>{" "}
                              {r.actor_role ? <RoleBadge role={r.actor_role} /> : null}
                            </td>
                            <td className="mono strong">{r.action}</td>
                            <td className="mono muted">
                              {r.target_ref ?? "—"}
                              {r.target_type ? <span className="muted"> ({r.target_type})</span> : null}
                            </td>
                            <td className="muted">{r.result ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="filter-foot">
                      <span className="hint">
                        Showing {offset + 1}–{offset + data.rows.length} of {data.total.toLocaleString()}
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn btn-ghost"
                          disabled={offset <= 0}
                          aria-disabled={offset <= 0}
                          onClick={() => setOffset(Math.max(0, offset - PAGE))}
                        >
                          ← Prev
                        </button>
                        <button
                          className="btn btn-ghost"
                          disabled={offset + data.rows.length >= data.total}
                          aria-disabled={offset + data.rows.length >= data.total}
                          onClick={() => setOffset(offset + PAGE)}
                        >
                          Next →
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </Card>
            </div>
          </>
        )}
      </QueryBoundary>
    </>
  );
}

function RolesCard({ roles }: { roles: { login: string; role: string; granted_by: string | null; granted_at: string | null }[] }) {
  const setRole = useSetRole();
  const [login, setLogin] = useState("");
  const [role, setRoleValue] = useState<Role>("author");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const l = login.trim();
    if (!l) return;
    setRole.mutate(
      { login: l, role },
      {
        onSuccess: () => setLogin(""),
      },
    );
  };

  const clear = (l: string) => {
    setRole.mutate({ login: l, role: null });
  };

  const err = setRole.error instanceof ApiError ? setRole.error.message : setRole.error ? "Failed to update role." : null;

  return (
    <Card
      title="Role overrides"
      subtitle="Per-login overrides take precedence over the env allowlists. Clearing one falls back to the env/viewer default."
    >
      <form onSubmit={submit} className="role-form">
        <label className="field">
          GitHub login
          <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="octocat" autoComplete="off" />
        </label>
        <label className="field">
          Role
          <select value={role} onChange={(e) => setRoleValue(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={setRole.isPending || !login.trim()}>
          {setRole.isPending ? "Saving…" : "Set role"}
        </button>
      </form>
      {err ? (
        <p style={{ color: "var(--sev-crit)", fontSize: 12.5, marginTop: 10 }}>{err}</p>
      ) : null}

      {roles.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          No overrides set — roles come from the env allowlists.
        </p>
      ) : (
        <table className="tbl" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Login</th>
              <th>Role</th>
              <th>Granted by</th>
              <th>When</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.login}>
                <td className="mono">{r.login}</td>
                <td>
                  <RoleBadge role={r.role} />
                </td>
                <td className="mono muted">{r.granted_by ?? "—"}</td>
                <td className="muted">{r.granted_at ? relativeTime(r.granted_at) : "—"}</td>
                <td className="right">
                  <button className="btn btn-link" onClick={() => clear(r.login)} disabled={setRole.isPending}>
                    Clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
