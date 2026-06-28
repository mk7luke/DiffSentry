import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReviewQueueEntry } from "../api/types";
import { DEMO } from "../demo/mode";

// ─────────────────────────────────────────────────────────────────────────────
// useEventStream — a single shared EventSource over /api/v1/stream.
//
// One <EventStreamProvider> opens exactly one connection for the whole app and
// fans incoming bus envelopes out to any number of useEventStream(handler)
// subscribers. EventSource handles reconnection + Last-Event-ID replay natively,
// so consumers just receive a clean stream of typed envelopes.
//
// Other worktrees/features subscribe with `useEventStream(cb)` — wrap the
// callback in useCallback so the subscription isn't torn down every render.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors BusEnvelope in src/realtime/bus.ts. */
export interface StreamEnvelope<P = unknown> {
  id: number;
  ts: string;
  topic: StreamTopic;
  payload: P;
}

export type StreamTopic =
  | "review.started"
  | "review.finished"
  | "review.failed"
  | "webhook.received"
  | "action.performed"
  | "settings.updated"
  | "budget.exceeded"
  | "finding.surfaced"
  | "notification.delivered"
  | "config.changed"
  | "settings.changed"
  | "token.changed"
  | "rule.changed"
  | "config.updated"
  | "learning.changed"
  | "queue.updated"
  | "webhook.replayed";

export interface ReviewLifecyclePayload {
  owner: string;
  repo: string;
  number: number;
  mode?: "full" | "incremental";
  error?: string;
}

export interface WebhookPayload {
  owner: string;
  repo: string;
  number: number | null;
  event: string;
  action?: string;
  kind: string;
}

export interface ActionPayload {
  owner: string;
  repo: string;
  number: number;
  action: string;
  actor: string | null;
  role: string | null;
  result: string;
  detail?: string;
}

export interface SettingsUpdatedPayload {
  instanceName: string;
  accentColor: string;
  updatedBy: string | null;
}

export interface BudgetAlertPayload {
  scope: string;
  owner: string | null;
  repo: string | null;
  month: string;
  spentUsd: number;
  budgetUsd: number;
}

export interface SettingsChangedPayload {
  scope: string;
  key: string;
  value: unknown;
  actor: string | null;
}

export interface TokenChangePayload {
  id: number;
  name: string | null;
  action: "create" | "revoke";
  actor: string | null;
  role: string | null;
  result: string;
}

export interface RuleChangedPayload {
  id: number | null;
  name: string;
  scope: string;
  action: "create" | "update" | "delete";
  actor: string | null;
  role: string | null;
}

export interface ConfigUpdatePayload {
  owner: string;
  repo: string;
  mode: "commit" | "pr";
  actor: string | null;
  role: string | null;
  branch: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
}

export interface LearningChangePayload {
  scope: "global" | "repo";
  owner?: string;
  repo?: string;
  action: string;
  id?: string;
  count?: number;
  actor: string | null;
  role: string | null;
}

/** Payload of a `queue.updated` event — the canonical board entry shape, kept
 * in one place to avoid drift. */
export type QueueUpdatedPayload = ReviewQueueEntry;

export interface WebhookReplayPayload {
  id: number;
  newDeliveryId: number | null;
  event: string;
  action: string | null;
  actor: string | null;
}

/** Every topic the server emits — the SSE `event:` names we listen for. */
const TOPICS: StreamTopic[] = [
  "review.started",
  "review.finished",
  "review.failed",
  "webhook.received",
  "action.performed",
  "settings.updated",
  "budget.exceeded",
  "finding.surfaced",
  "notification.delivered",
  "config.changed",
  "settings.changed",
  "token.changed",
  "rule.changed",
  "config.updated",
  "learning.changed",
  "queue.updated",
  "webhook.replayed",
];

type Listener = (env: StreamEnvelope) => void;

/** Live SSE connection health, surfaced to the Ops Console indicator. */
export type StreamStatus = "connecting" | "live" | "reconnecting";

interface StreamContextValue {
  subscribe: (listener: Listener) => () => void;
}

const StreamContext = createContext<StreamContextValue | null>(null);
// Status lives in its own context so a status change never re-renders the
// (stable) subscribe value and tears down every useEventStream subscription.
const StreamStatusContext = createContext<StreamStatus>("connecting");

export function EventStreamProvider({ children }: { children: ReactNode }) {
  // A stable Set of listeners. The EventSource pushes into it; subscribers
  // add/remove themselves. Using a ref keeps the connection effect from
  // re-running when the listener set changes.
  const listeners = useRef<Set<Listener>>(new Set());
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    // Demo mode has no backend stream — never open a connection (it would 404
    // and retry forever). Fixtures are static, so there's nothing to live-tail.
    if (DEMO) return;
    // same-origin; cookies (ds_session) flow automatically.
    const es = new EventSource("/api/v1/stream");
    const handlers: Array<[StreamTopic, (e: MessageEvent) => void]> = [];

    // EventSource reconnects on its own; mirror its state into our indicator.
    es.onopen = () => setStatus("live");
    es.onerror = () => {
      // CLOSED (2) won't auto-recover; CONNECTING (0) means a retry is pending.
      // Either way the stream isn't live right now.
      setStatus("reconnecting");
    };

    for (const topic of TOPICS) {
      const onMessage = (e: MessageEvent) => {
        // Any delivered frame proves the socket is open — recover the indicator
        // even if onopen was missed across a reconnect.
        setStatus("live");
        let env: StreamEnvelope;
        try {
          env = JSON.parse(e.data) as StreamEnvelope;
        } catch {
          return; // ignore malformed frames
        }
        for (const l of listeners.current) {
          try {
            l(env);
          } catch {
            // a misbehaving subscriber never breaks the fan-out
          }
        }
      };
      es.addEventListener(topic, onMessage);
      handlers.push([topic, onMessage]);
    }

    return () => {
      for (const [topic, fn] of handlers) es.removeEventListener(topic, fn);
      es.close();
    };
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  // Memoized so its identity is stable across status-driven re-renders.
  const streamValue = useMemo<StreamContextValue>(() => ({ subscribe }), [subscribe]);

  return (
    <StreamContext.Provider value={streamValue}>
      <StreamStatusContext.Provider value={status}>{children}</StreamStatusContext.Provider>
    </StreamContext.Provider>
  );
}

/** Current SSE connection health. Safe outside the provider (returns "connecting"). */
export function useStreamStatus(): StreamStatus {
  return useContext(StreamStatusContext);
}

/**
 * Subscribe to the shared event stream. `handler` should be memoized
 * (useCallback) so the subscription is stable across renders. Safe to call
 * outside the provider — it simply no-ops.
 */
export function useEventStream(handler: Listener): void {
  const ctx = useContext(StreamContext);
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(handler);
  }, [ctx, handler]);
}
