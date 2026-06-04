import { useState } from "react";
import {
  useNotifications,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
  useTestChannel,
  useCreateAlertRule,
  useUpdateAlertRule,
  useDeleteAlertRule,
} from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, PageHeader } from "../components/primitives";
import { EmptyState, LoadingState, QueryBoundary } from "../components/states";
import { ApiError } from "../api/client";
import type { AlertRule, ChannelType, NotificationChannel } from "../api/types";
import { relativeTime } from "../lib/format";

const CHANNEL_TYPES: ChannelType[] = ["slack", "discord", "webhook", "email"];
const EVENT_LABELS: Record<string, string> = {
  finding: "Finding surfaced",
  review_failed: "Review failed",
  budget: "Budget exceeded",
  digest: "Weekly digest",
  any: "Any event",
};
const SEVERITIES = ["critical", "major", "minor", "nit"];

export function NotificationsPage() {
  const { capabilities, isLoading } = useAuth();

  if (isLoading) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Notifications" }]} />
        <PageHeader title="Notifications" subtitle="Admin only." />
        <LoadingState label="Loading…" />
      </>
    );
  }

  if (!capabilities.manageNotifications) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Notifications" }]} />
        <PageHeader title="Notifications" subtitle="Admin only." />
        <section className="card tone-danger">
          <div className="empty">
            <div className="mono" style={{ color: "var(--sev-crit)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
              403 · FORBIDDEN
            </div>
            <div className="title">You need the admin role to manage notifications.</div>
          </div>
        </section>
      </>
    );
  }

  return <NotificationsContent />;
}

function NotificationsContent() {
  const query = useNotifications(true);
  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Notifications" }]} />
      <PageHeader
        title="Notifications"
        subtitle="Push DiffSentry signal out to Slack, Discord, a webhook, or email. Rules route events to channels; the weekly digest is a digest rule."
      />
      <QueryBoundary query={query} loadingLabel="Loading notifications…">
        {(data) => (
          <>
            <ChannelsCard channels={data.channels} />
            <div style={{ marginTop: 16 }}>
              <RulesCard rules={data.rules} channels={data.channels} />
            </div>
            <div style={{ marginTop: 16 }}>
              <DeliveriesCard deliveries={data.deliveries} />
            </div>
          </>
        )}
      </QueryBoundary>
    </>
  );
}

// ─── Channels ───────────────────────────────────────────────────────

function configSummary(ch: NotificationChannel): string {
  const c = ch.config ?? {};
  if (ch.type === "slack" || ch.type === "discord") return String(c.webhookUrl ?? "—");
  if (ch.type === "webhook") return String(c.url ?? "—");
  if (ch.type === "email") return String(c.to ?? "—");
  return "—";
}

function ChannelsCard({ channels }: { channels: NotificationChannel[] }) {
  const create = useCreateChannel();
  const update = useUpdateChannel();
  const del = useDeleteChannel();
  const test = useTestChannel();
  const { push } = useToast();

  const [type, setType] = useState<ChannelType>("slack");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState(""); // webhookUrl / url / email "to"

  const secretLabel =
    type === "email" ? "Recipient email" : type === "webhook" ? "Webhook URL" : "Incoming webhook URL";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = secret.trim();
    if (!value) return;
    const config: Record<string, unknown> =
      type === "email" ? { to: value } : type === "webhook" ? { url: value } : { webhookUrl: value };
    create.mutate(
      { type, name: name.trim() || null, config },
      {
        onSuccess: () => {
          setName("");
          setSecret("");
          push({ tone: "success", title: "Channel added" });
        },
        onError: (err) => push({ tone: "danger", title: "Add failed", body: msg(err) }),
      },
    );
  };

  const runTest = (id: number) => {
    test.mutate(id, {
      onSuccess: (r) =>
        push({
          tone: r.ok ? "success" : "danger",
          title: r.ok ? "Test sent" : "Test failed",
          body: r.detail,
        }),
      onError: (err) => push({ tone: "danger", title: "Test failed", body: msg(err) }),
    });
  };

  return (
    <Card title="Channels" subtitle="Where notifications are delivered. Secrets are masked after saving.">
      <form onSubmit={submit} className="role-form" style={{ flexWrap: "wrap" }}>
        <label className="field">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            {CHANNEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #eng-alerts" autoComplete="off" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 240 }}>
          {secretLabel}
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={type === "email" ? "team@example.com" : "https://…"}
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !secret.trim()}>
          {create.isPending ? "Adding…" : "Add channel"}
        </button>
      </form>

      {channels.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          No channels yet. Add a Slack incoming webhook to get started.
        </p>
      ) : (
        <table className="tbl" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Type</th>
              <th>Name</th>
              <th>Destination</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr key={ch.id}>
                <td>
                  <Chip tone="accent" uppercase>
                    {ch.type}
                  </Chip>
                </td>
                <td>{ch.name ?? <span className="muted">—</span>}</td>
                <td className="mono muted" title={configSummary(ch)}>
                  {configSummary(ch)}
                </td>
                <td>
                  <Chip tone={ch.enabled ? "good" : "muted"} dot>
                    {ch.enabled ? "enabled" : "disabled"}
                  </Chip>
                </td>
                <td className="right" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-ghost" onClick={() => runTest(ch.id)} disabled={test.isPending}>
                    Send test
                  </button>{" "}
                  <button
                    className="btn btn-link"
                    onClick={() => update.mutate({ id: ch.id, patch: { enabled: !ch.enabled } })}
                    disabled={update.isPending}
                  >
                    {ch.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    className="btn btn-link"
                    onClick={() => {
                      if (window.confirm(`Delete channel "${ch.name ?? ch.type}"?`)) del.mutate(ch.id);
                    }}
                    disabled={del.isPending}
                  >
                    Delete
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

// ─── Rules ──────────────────────────────────────────────────────────

function RulesCard({ rules, channels }: { rules: AlertRule[]; channels: NotificationChannel[] }) {
  const create = useCreateAlertRule();
  const update = useUpdateAlertRule();
  const del = useDeleteAlertRule();
  const { push } = useToast();

  const [event, setEvent] = useState("finding");
  const [minSeverity, setMinSeverity] = useState("critical");
  const [scope, setScope] = useState("");
  const [channelId, setChannelId] = useState<number | "">(channels[0]?.id ?? "");
  const [name, setName] = useState("");

  const channelName = (id: number | null) => channels.find((c) => c.id === id)?.name ?? (id != null ? `#${id}` : "—");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (channelId === "") {
      push({ tone: "danger", title: "Pick a channel" });
      return;
    }
    const condition: { event: string; minSeverity?: string } = { event };
    if (event === "finding") condition.minSeverity = minSeverity;
    create.mutate(
      { name: name.trim() || null, scope: scope.trim() || "global", condition, channelId: Number(channelId) },
      {
        onSuccess: () => {
          setName("");
          setScope("");
          push({ tone: "success", title: "Rule added" });
        },
        onError: (err) => push({ tone: "danger", title: "Add failed", body: msg(err) }),
      },
    );
  };

  return (
    <Card
      title="Alert rules"
      subtitle="Route events to a channel. Scope to a single owner/repo or leave blank for all. A 'digest' rule sends the weekly rollup."
    >
      {channels.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          Add a channel first — rules need somewhere to deliver.
        </p>
      ) : (
        <form onSubmit={submit} className="role-form" style={{ flexWrap: "wrap" }}>
          <label className="field">
            Event
            <select value={event} onChange={(e) => setEvent(e.target.value)}>
              {Object.keys(EVENT_LABELS).map((ev) => (
                <option key={ev} value={ev}>
                  {EVENT_LABELS[ev]}
                </option>
              ))}
            </select>
          </label>
          {event === "finding" ? (
            <label className="field">
              Min severity
              <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            Scope
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="owner/repo (blank = all)" autoComplete="off" />
          </label>
          <label className="field">
            Channel
            <select value={channelId} onChange={(e) => setChannelId(e.target.value === "" ? "" : Number(e.target.value))}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? `${c.type} #${c.id}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" autoComplete="off" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add rule"}
          </button>
        </form>
      )}

      {rules.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          No rules yet.
        </p>
      ) : (
        <table className="tbl" style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Event</th>
              <th>Scope</th>
              <th>Channel</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  {EVENT_LABELS[r.condition.event] ?? r.condition.event}
                  {r.condition.event === "finding" && r.condition.minSeverity ? (
                    <span className="muted"> ≥ {r.condition.minSeverity}</span>
                  ) : null}
                  {r.name ? <div className="muted" style={{ fontSize: 11 }}>{r.name}</div> : null}
                </td>
                <td className="mono muted">{r.scope ?? "global"}</td>
                <td>{channelName(r.channel_id)}</td>
                <td>
                  <Chip tone={r.enabled ? "good" : "muted"} dot>
                    {r.enabled ? "on" : "off"}
                  </Chip>
                </td>
                <td className="right" style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="btn btn-link"
                    onClick={() => update.mutate({ id: r.id, patch: { enabled: !r.enabled } })}
                    disabled={update.isPending}
                  >
                    {r.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button className="btn btn-link" onClick={() => del.mutate(r.id)} disabled={del.isPending}>
                    Delete
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

// ─── Deliveries ─────────────────────────────────────────────────────

function DeliveriesCard({ deliveries }: { deliveries: import("../api/types").NotificationDeliveryRow[] }) {
  return (
    <Card title="Recent deliveries" subtitle="The last 50 sends — from rules, the digest, and test buttons." bodyClass="flush">
      {deliveries.length === 0 ? (
        <EmptyState title="No deliveries yet" hint="Matching events and test sends will show up here." />
      ) : (
        <table className="tbl rail">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Trigger</th>
              <th>Target</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className="muted" title={d.ts}>
                  {relativeTime(d.ts)}
                </td>
                <td>
                  {d.channel_name ?? d.channel_type ?? "—"}
                  {d.channel_type ? <span className="muted"> ({d.channel_type})</span> : null}
                </td>
                <td className="mono">{d.trigger ?? "—"}</td>
                <td className="mono muted">{d.target ?? "—"}</td>
                <td>
                  <Chip tone={d.status === "ok" ? "good" : "danger"} dot>
                    {d.status}
                  </Chip>
                </td>
                <td className="muted" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.detail ?? ""}>
                  {d.detail ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function msg(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
