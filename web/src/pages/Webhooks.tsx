import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useReplayWebhook, useWebhookDelivery, useWebhooks } from "../api/hooks";
import { useAuth } from "../auth/useAuth";
import { useToast } from "../realtime/toast";
import { useEventStream, type StreamEnvelope } from "../realtime/useEventStream";
import { useQueryClient } from "@tanstack/react-query";
import { Breadcrumbs } from "../components/Shell";
import { Card, Chip, PageHeader } from "../components/primitives";
import { JsonView } from "../components/JsonView";
import { EmptyState, LoadingState, QueryBoundary } from "../components/states";
import { ApiError } from "../api/client";
import { formatBytes, pluralize, relativeTime } from "../lib/format";
import type { WebhookDeliveryRow } from "../api/types";

const PAGE = 100;

/** Admin-only screen: raw webhook delivery capture + replay. The nav link is
 * hidden for non-admins; this guard covers a direct visit (server returns 403
 * regardless). */
export function WebhooksPage() {
  const { capabilities, isLoading } = useAuth();

  if (isLoading) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Webhooks" }]} />
        <PageHeader title="Webhook deliveries" subtitle="Admin only." />
        <LoadingState label="Loading…" />
      </>
    );
  }

  // Reuse the audit capability — raw payloads are as sensitive as the audit log.
  if (!capabilities.viewAudit) {
    return (
      <>
        <Breadcrumbs crumbs={[{ label: "Webhooks" }]} />
        <PageHeader title="Webhook deliveries" subtitle="Admin only." />
        <section className="card tone-danger">
          <div className="empty">
            <div className="mono" style={{ color: "var(--sev-crit)", fontSize: 11, letterSpacing: "0.12em", marginBottom: 8 }}>
              403 · FORBIDDEN
            </div>
            <div className="title">You need the admin role to inspect webhook deliveries.</div>
          </div>
        </section>
      </>
    );
  }

  return <WebhooksContent />;
}

function WebhooksContent() {
  const [params, setParams] = useSearchParams();
  const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);
  const event = params.get("event") ?? undefined;
  const repo = params.get("repo") ?? undefined;

  const query = useWebhooks({ event, repo, limit: PAGE, offset }, true);
  const qc = useQueryClient();

  // Live-refresh the list when anyone replays a delivery (a new row appears).
  const onEvent = useCallback(
    (env: StreamEnvelope) => {
      if (env.topic === "webhook.replayed") void qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    [qc],
  );
  useEventStream(onEvent);

  const setFilter = (key: "event" | "repo", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("offset");
    setParams(next);
  };

  const setOffset = (o: number) => {
    const next = new URLSearchParams(params);
    if (o <= 0) next.delete("offset");
    else next.set("offset", String(o));
    setParams(next);
  };

  return (
    <>
      <Breadcrumbs crumbs={[{ label: "Webhooks" }]} />
      <PageHeader
        title="Webhook deliveries"
        subtitle="Every raw delivery GitHub sent — inspect the payload and replay it through the engine. Admin only."
      />

      <QueryBoundary query={query} loadingLabel="Loading deliveries…">
        {(data) => (
          <Card
            title="Deliveries"
            subtitle={`${data.total.toLocaleString()} ${pluralize(data.total, "delivery", "deliveries")}`}
            right={
              <span style={{ display: "inline-flex", gap: 8 }}>
                {data.events.length > 0 ? (
                  <label className="field" style={{ marginBottom: 0 }}>
                    <select value={event ?? ""} onChange={(e) => setFilter("event", e.target.value)}>
                      <option value="">all events</option>
                      {data.events.map((ev) => (
                        <option key={ev} value={ev}>
                          {ev}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {data.repos.length > 0 ? (
                  <label className="field" style={{ marginBottom: 0 }}>
                    <select value={repo ?? ""} onChange={(e) => setFilter("repo", e.target.value)}>
                      <option value="">all repos</option>
                      {data.repos.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </span>
            }
            bodyClass="flush"
          >
            {data.rows.length === 0 ? (
              <EmptyState
                title="No deliveries captured"
                hint="Deliveries are recorded as GitHub sends webhooks. Once persistence is on and a hook fires, it shows up here."
              />
            ) : (
              <>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th />
                      <th>When</th>
                      <th>Event</th>
                      <th>Repo</th>
                      <th>Signature</th>
                      <th className="num">Size</th>
                      <th className="right">Replay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <DeliveryRow key={row.id} row={row} />
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
        )}
      </QueryBoundary>
    </>
  );
}

function DeliveryRow({ row }: { row: WebhookDeliveryRow }) {
  const [open, setOpen] = useState(false);
  const { push } = useToast();
  const replay = useReplayWebhook();

  const eventLabel = [row.event, row.action].filter(Boolean).join(".") || row.event || "—";
  const repoSlug = row.owner && row.repo ? `${row.owner}/${row.repo}` : null;
  const sig =
    row.signature_ok === 1 ? (
      <Chip tone="good" dot>
        verified
      </Chip>
    ) : row.signature_ok === 0 ? (
      <Chip tone="danger" dot title="Signature verification failed — not dispatched">
        rejected
      </Chip>
    ) : (
      <Chip tone="muted">n/a</Chip>
    );

  const doReplay = () => {
    if (!window.confirm(`Replay delivery #${row.id} (${eventLabel}) through the engine?`)) return;
    replay.mutate(row.id, {
      onSuccess: (data) => {
        push({
          tone: "info",
          title: `Replayed #${row.id}`,
          body: data.newDeliveryId ? `New delivery #${data.newDeliveryId} dispatched (HTTP ${data.dispatchStatus}).` : `Dispatched (HTTP ${data.dispatchStatus}).`,
        });
      },
      onError: (err) => {
        const message = err instanceof ApiError ? err.message : "Replay failed.";
        push({ tone: "danger", title: "Replay failed", body: message });
      },
    });
  };

  return (
    <>
      <tr className={open ? "row-open" : undefined}>
        <td className="cell-toggle">
          <button
            type="button"
            className="btn-disclose"
            aria-expanded={open}
            aria-label={open ? "Collapse payload" : "Expand payload"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td className="muted" title={row.ts}>
          {relativeTime(row.ts)}
        </td>
        <td>
          <span className="mono strong">{eventLabel}</span>
          {row.replayed_from != null ? (
            <>
              {" "}
              <Chip tone="accent" title={`Replay of delivery #${row.replayed_from}`}>
                replay of #{row.replayed_from}
              </Chip>
            </>
          ) : null}
        </td>
        <td className="mono">
          {repoSlug ? (
            <>
              <Link className="link" to={`/repos/${encodeURIComponent(row.owner!)}/${encodeURIComponent(row.repo!)}`}>
                {repoSlug}
              </Link>
              {row.number != null ? <span className="muted"> #{row.number}</span> : null}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>{sig}</td>
        <td className="num muted">{formatBytes(row.payload_bytes)}</td>
        <td className="right">
          <button
            className="btn btn-ghost"
            onClick={doReplay}
            disabled={replay.isPending}
            aria-busy={replay.isPending}
            title="Re-dispatch this payload through the engine"
          >
            {replay.isPending ? <span className="spinner btn-spinner" /> : null}
            {replay.isPending ? "Replaying…" : "Replay"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="row-detail">
          <td colSpan={7}>
            <DeliveryPayload id={row.id} deliveryId={row.delivery_id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DeliveryPayload({ id, deliveryId }: { id: number; deliveryId: string | null }) {
  const query = useWebhookDelivery(id);
  if (query.isPending) return <LoadingState label="Loading payload…" />;
  if (query.isError) {
    const message = query.error instanceof ApiError ? query.error.message : "Failed to load payload.";
    return <p style={{ color: "var(--sev-crit)", fontSize: 12.5, padding: "4px 2px" }}>{message}</p>;
  }
  const row = query.data;
  return (
    <div className="delivery-detail">
      <div className="delivery-meta">
        {deliveryId ? (
          <span className="kvi">
            <span className="kvi-k">X-GitHub-Delivery</span>
            <span className="kvi-v mono">{deliveryId}</span>
          </span>
        ) : null}
        <span className="kvi">
          <span className="kvi-k">Captured</span>
          <span className="kvi-v">{row.ts}</span>
        </span>
      </div>
      {row.payload_json ? (
        <JsonView json={row.payload_json} />
      ) : (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No payload was stored for this delivery.
        </p>
      )}
    </div>
  );
}
