import { useState } from "react";
import {
  useDiagnostics,
  useGithubDiagnostics,
  useTestAi,
  useTestWebhook,
} from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { Breadcrumbs } from "../components/Shell";
import { Card, Metric, PageHeader } from "../components/primitives";
import { CheckList } from "../components/diagnostics";
import { GithubIcon } from "../components/icons";
import { EmptyState, QueryBoundary } from "../components/states";
import type { GithubDiagnosticsResponse, TestAiResult, TestWebhookResult } from "../api/types";
import { formatBytes, relativeTime } from "../lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics — the permanent health/setup screen under Settings.
//
// Static checks (env + DB) load immediately. The GitHub App probe and the
// AI / webhook self-tests are explicit actions (network + provider cost), so
// they run on demand and render their results inline.
// ─────────────────────────────────────────────────────────────────────────────

function AiTestCard({ provider, model }: { provider: string; model: string }) {
  const { capabilities } = useAuth();
  const test = useTestAi();
  const result = test.data as TestAiResult | undefined;
  const allowed = capabilities.triggerReview;
  return (
    <Card
      title="AI provider"
      subtitle={
        <>
          <span className="mono">{provider}</span> · <span className="mono">{model}</span>
        </>
      }
    >
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Send a tiny prompt to confirm the provider is reachable and the credentials work.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => test.mutate()}
        disabled={!allowed || test.isPending}
        title={allowed ? undefined : "Requires the author role"}
      >
        {test.isPending ? <span className="spinner btn-spinner" /> : null}
        {test.isPending ? "Testing…" : "Run test AI call"}
      </button>
      {result ? (
        <div className={`diag-result ${result.ok ? "ok" : "fail"}`} style={{ marginTop: 12 }}>
          {result.ok ? (
            <>
              <strong>Reachable</strong> in {result.latencyMs}ms.
              {result.reply ? (
                <>
                  {" "}
                  Replied: <span className="mono">{result.reply}</span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <strong>Failed:</strong> {result.error}
            </>
          )}
        </div>
      ) : null}
      {test.isError ? (
        <div className="diag-result fail" style={{ marginTop: 12 }}>
          <strong>Request failed.</strong> You may lack permission, or the server errored.
        </div>
      ) : null}
    </Card>
  );
}

function WebhookTestCard() {
  const { capabilities } = useAuth();
  const test = useTestWebhook();
  const result = test.data as TestWebhookResult | undefined;
  const allowed = capabilities.triggerReview;
  return (
    <Card title="Webhook signature" subtitle="Local self-test — does not contact GitHub">
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Signs a synthetic payload and verifies it through the same pipeline{" "}
        <span className="mono">/webhook</span> uses, proving the webhook secret is wired correctly.
      </p>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => test.mutate()}
        disabled={!allowed || test.isPending}
        title={allowed ? undefined : "Requires the author role"}
      >
        {test.isPending ? <span className="spinner btn-spinner" /> : null}
        {test.isPending ? "Testing…" : "Test webhook secret"}
      </button>
      {result ? (
        <div className={`diag-result ${result.ok ? "ok" : "fail"}`} style={{ marginTop: 12 }}>
          {result.ok ? (
            <strong>Signature round-trip verified.</strong>
          ) : (
            <>
              <strong>Failed:</strong> {result.error}
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function deliveryStatus(code: number): "ok" | "warn" | "fail" {
  if (code >= 200 && code < 300) return "ok";
  if (code === 0) return "fail";
  return "warn";
}

function GithubProbeCard() {
  const [enabled, setEnabled] = useState(false);
  const query = useGithubDiagnostics(enabled);
  const gh = query.data as GithubDiagnosticsResponse | undefined;

  return (
    <Card
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <GithubIcon style={{ width: 16, height: 16 }} /> GitHub App
        </span>
      }
      subtitle="Installations, connected repos, webhook delivery health & rate limit"
      right={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setEnabled(true);
            if (enabled) void query.refetch();
          }}
          disabled={query.isFetching}
        >
          {query.isFetching ? "Probing…" : enabled ? "Re-probe" : "Probe GitHub"}
        </button>
      }
    >
      {!enabled ? (
        <EmptyState
          title="Not probed yet"
          hint="Probing calls the GitHub API to list installations and recent webhook deliveries."
        />
      ) : query.isPending ? (
        <div className="center-pad">
          <span className="spinner" />
          <span>Contacting GitHub…</span>
        </div>
      ) : query.isError ? (
        <div className="diag-result fail">Could not reach GitHub. Check the App ID and private key.</div>
      ) : gh ? (
        <GithubProbeResult gh={gh} />
      ) : null}
    </Card>
  );
}

function GithubProbeResult({ gh }: { gh: GithubDiagnosticsResponse }) {
  return (
    <>
      {gh.error ? (
        <div className="diag-result fail" style={{ marginBottom: 12 }}>
          <strong>App auth failed:</strong> {gh.error}
        </div>
      ) : null}

      <div className="grid three" style={{ marginBottom: 14 }}>
        <Metric label="App" value={gh.app?.slug ?? gh.app?.name ?? "—"} />
        <Metric label="Installations" value={gh.installationCount} tone={gh.installationCount > 0 ? "good" : "danger"} />
        <Metric label="Connected repos" value={gh.connectedRepos} tone={gh.connectedRepos > 0 ? "good" : "danger"} />
      </div>

      {gh.installationCount === 0 ? (
        <div className="diag-result warn" style={{ marginBottom: 14 }}>
          <strong>The App isn't installed anywhere yet.</strong>{" "}
          {gh.app?.htmlUrl ? (
            <a href={`${gh.app.htmlUrl}/installations/new`} target="_blank" rel="noreferrer">
              Install it on a repository →
            </a>
          ) : (
            "Install it on a repository from your GitHub App's public page."
          )}
        </div>
      ) : (
        <div className="diag-installs" style={{ marginBottom: 14 }}>
          {gh.installations.map((inst) => (
            <div key={inst.id} className="diag-install">
              <div className="diag-install-head">
                <span className="mono">{inst.account ?? `installation #${inst.id}`}</span>
                <span className="muted">
                  {inst.repoCount} {inst.repoCount === 1 ? "repo" : "repos"}
                  {inst.repositorySelection === "all" ? " (all)" : ""}
                </span>
              </div>
              {inst.repos.length > 0 ? (
                <div className="diag-repos">
                  {inst.repos.map((r) => (
                    <span key={r} className="chip neutral">
                      {r}
                    </span>
                  ))}
                  {inst.truncated ? <span className="muted">+{inst.repoCount - inst.repos.length} more</span> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="diag-subhead">Webhook deliveries</div>
      {gh.webhook.error ? (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Couldn't read deliveries: {gh.webhook.error}
        </div>
      ) : gh.webhook.deliveries.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
          No recent deliveries.{" "}
          {gh.webhook.configuredUrl ? (
            <>
              Endpoint: <span className="mono">{gh.webhook.configuredUrl}</span>.
            </>
          ) : (
            "No webhook URL configured on the App."
          )}
        </div>
      ) : (
        <div className="diag-deliveries">
          {gh.webhook.deliveries.map((d) => (
            <div className="logrow" key={d.id}>
              <span className="ts">{relativeTime(d.deliveredAt)}</span>
              <span className={`diag-badge ${deliveryStatus(d.statusCode)}`}>{d.statusCode || "—"}</span>
              <span className="msg mono">
                {d.event}
                {d.action ? `.${d.action}` : ""} — {d.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {gh.rateLimit ? (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
          Rate limit: {gh.rateLimit.remaining}/{gh.rateLimit.limit} remaining · resets{" "}
          {relativeTime(gh.rateLimit.reset)}.
        </p>
      ) : null}
    </>
  );
}

export function DiagnosticsPage() {
  const query = useDiagnostics();
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Settings", to: "/settings" }, { label: "Diagnostics" }]} />
      <PageHeader
        title="Diagnostics"
        subtitle="What's configured, what's missing, and whether the moving parts can actually reach each other."
      />
      <QueryBoundary query={query} loadingLabel="Running diagnostics…">
        {(data) => (
          <>
            <div className="grid three" style={{ marginBottom: 16 }}>
              <Metric label="Healthy" value={data.summary.ok} tone="good" />
              <Metric label="Warnings" value={data.summary.warn} tone={data.summary.warn > 0 ? "neutral" : "good"} />
              <Metric label="Action needed" value={data.summary.fail} tone={data.summary.fail > 0 ? "danger" : "good"} />
            </div>

            <Card title="Configuration checks" bodyClass="tight" subtitle="Read from the environment and the database">
              <CheckList checks={data.checks} />
            </Card>

            <div className="grid two" style={{ marginTop: 16 }}>
              <AiTestCard provider={data.config.provider} model={data.config.model} />
              <WebhookTestCard />
            </div>

            <div style={{ marginTop: 16 }}>
              <GithubProbeCard />
            </div>

            <Card title="Persistence" subtitle="SQLite-backed history" right={null}>
              <div className="grid three">
                <Metric label="Status" value={data.db.enabled ? "On" : "Off"} tone={data.db.enabled ? "good" : "danger"} />
                <Metric label="DB size" value={formatBytes(data.db.sizeBytes)} />
                <Metric label="Last review" value={data.db.lastReviewAt ? relativeTime(data.db.lastReviewAt) : "—"} />
              </div>
            </Card>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
