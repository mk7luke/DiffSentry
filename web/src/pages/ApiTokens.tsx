import { useState } from "react";
import { useCreateToken, useRevokeToken, useTokens } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, PageHeader } from "../components/primitives";
import { EmptyState, LoadingState, QueryBoundary } from "../components/states";
import { BookIcon } from "../components/icons";
import { ApiError } from "../api/client";
import type { ApiScope, CreatedToken } from "../api/types";
import { relativeTime } from "../lib/format";

const DOCS_URL = "/api/v1/docs";

const SCOPE_HELP: Record<ApiScope, string> = {
  read: "Read every GET endpoint (repos, findings, patterns, health).",
  review: "Trigger reviews and the safe action subset (implies read).",
};

/** Admin-only screen: create / list / revoke platform API tokens, plus a link
 * to the rendered OpenAPI docs. The nav link is hidden for non-admins; this
 * guard covers a direct visit (and the server returns 403 regardless). */
export function ApiTokensPage() {
  const { capabilities, isLoading } = useAuth();

  if (isLoading) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "API tokens" }]} />
        <PageHeader title="API tokens" subtitle="Admin only." />
        <LoadingState label="Loading…" />
      </>
    );
  }

  if (!capabilities.manageTokens) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "API tokens" }]} />
        <PageHeader title="API tokens" subtitle="Admin only." />
        <section className="card tone-danger">
          <div className="empty">
            <div className="mono" style={{ color: "var(--sev-crit)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
              403 · FORBIDDEN
            </div>
            <div className="title">You need the admin role to manage API tokens.</div>
          </div>
        </section>
      </>
    );
  }

  return <ApiTokensContent />;
}

function ApiTokensContent() {
  const query = useTokens(true);

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "API tokens" }]} />
      <PageHeader
        title="API tokens"
        subtitle="Bearer credentials for the DiffSentry platform API. Tokens carry scopes and can be revoked at any time."
        right={
          <a className="btn btn-ghost" href={DOCS_URL} target="_blank" rel="noreferrer">
            <BookIcon style={{ width: 15, height: 15 }} /> API docs ↗
          </a>
        }
      />

      <QueryBoundary query={query} loadingLabel="Loading tokens…">
        {(data) => (
          <>
            <CreateTokenCard availableScopes={data.availableScopes} />
            <div style={{ marginTop: 16 }}>
              <TokenList tokens={data.tokens} />
            </div>
          </>
        )}
      </QueryBoundary>
    </>
  );
}

function CreateTokenCard({ availableScopes }: { availableScopes: ApiScope[] }) {
  const create = useCreateToken();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["read"]);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const toggle = (s: ApiScope) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    // `review` implies `read`; the server normalizes too, but mirror it here so
    // the displayed scopes match what gets stored.
    const requested = scopes.includes("review") && !scopes.includes("read") ? [...scopes, "read" as ApiScope] : scopes;
    create.mutate(
      { name: n, scopes: requested.length ? requested : ["read"] },
      {
        onSuccess: (data) => {
          setCreated(data);
          setName("");
          setScopes(["read"]);
        },
      },
    );
  };

  const err = create.error instanceof ApiError ? create.error.message : create.error ? "Failed to create token." : null;

  return (
    <Card
      title="Create a token"
      subtitle="The secret is shown once, immediately after creation — store it now; it can't be retrieved again."
    >
      <form onSubmit={submit} className="role-form">
        <label className="field" style={{ minWidth: 220 }}>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ci-pipeline"
            autoComplete="off"
            maxLength={120}
          />
        </label>
        <fieldset className="scope-picker">
          <legend>Scopes</legend>
          {availableScopes.map((s) => (
            <label key={s} className="scope-opt" title={SCOPE_HELP[s]}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              <span className="mono">{s}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim()}>
          {create.isPending ? "Creating…" : "Create token"}
        </button>
      </form>
      {err ? <p style={{ color: "var(--sev-crit)", fontSize: 12.5, marginTop: 10 }}>{err}</p> : null}

      {created ? <RevealedToken created={created} onDismiss={() => setCreated(null)} /> : null}
    </Card>
  );
}

function RevealedToken({ created, onDismiss }: { created: CreatedToken; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be blocked (insecure context); the value is selectable.
    }
  };
  return (
    <div className="token-reveal" role="alert">
      <div className="token-reveal-head">
        <strong>Token “{created.name}” created.</strong>
        <span className="muted"> Copy it now — it won't be shown again.</span>
      </div>
      <div className="token-reveal-row">
        <code className="mono token-secret">{created.token}</code>
        <button type="button" className="btn btn-ghost" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button type="button" className="btn btn-link" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Scopes: {created.scopes.map((s) => <span key={s} className="chip neutral mono" style={{ marginRight: 6 }}>{s}</span>)}
      </div>
      <pre className="token-curl mono">{`curl -H "Authorization: Bearer ${created.token}" \\
  ${window.location.origin}/api/v1/repos`}</pre>
    </div>
  );
}

function TokenList({ tokens }: { tokens: import("../api/types").ApiTokenMeta[] }) {
  const revoke = useRevokeToken();
  const err = revoke.error instanceof ApiError ? revoke.error.message : revoke.error ? "Failed to revoke token." : null;

  return (
    <Card title="Tokens" subtitle={`${tokens.length} total`} bodyClass="flush">
      {err ? <p style={{ color: "var(--sev-crit)", fontSize: 12.5, padding: "10px 16px 0" }}>{err}</p> : null}
      {tokens.length === 0 ? (
        <EmptyState title="No tokens yet" hint="Create one above to grant programmatic access to the API." />
      ) : (
        <table className="tbl rail">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Created by</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const revoked = !!t.revoked_at;
              return (
                <tr key={t.id} style={revoked ? { opacity: 0.55 } : undefined}>
                  <td className="strong">{t.name ?? <span className="muted">—</span>}</td>
                  <td>
                    {t.scopes.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      t.scopes.map((s) => (
                        <span key={s} className="chip neutral mono" style={{ marginRight: 5 }}>
                          {s}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="mono muted">{t.created_by ?? "—"}</td>
                  <td className="muted" title={t.created_at ?? undefined}>
                    {t.created_at ? relativeTime(t.created_at) : "—"}
                  </td>
                  <td className="muted" title={t.last_used_at ?? undefined}>
                    {t.last_used_at ? relativeTime(t.last_used_at) : <span className="muted">never</span>}
                  </td>
                  <td>
                    {revoked ? (
                      <span className="chip danger uppercase">revoked</span>
                    ) : (
                      <span className="chip good uppercase">active</span>
                    )}
                  </td>
                  <td className="right">
                    {revoked ? (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {t.revoked_at ? relativeTime(t.revoked_at) : ""}
                      </span>
                    ) : (
                      <button
                        className="btn btn-link"
                        onClick={() => {
                          if (window.confirm(`Revoke token “${t.name ?? t.id}”? Any client using it stops working immediately.`)) {
                            revoke.mutate(t.id);
                          }
                        }}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
