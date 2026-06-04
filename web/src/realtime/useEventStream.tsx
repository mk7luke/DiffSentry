import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import type { ReviewQueueEntry } from "../api/types";

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
  | "action.performed"
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
  "action.performed",
  "learning.changed",
  "queue.updated",
  "webhook.replayed",
];

type Listener = (env: StreamEnvelope) => void;

interface StreamContextValue {
  subscribe: (listener: Listener) => () => void;
}

const StreamContext = createContext<StreamContextValue | null>(null);

export function EventStreamProvider({ children }: { children: ReactNode }) {
  // A stable Set of listeners. The EventSource pushes into it; subscribers
  // add/remove themselves. Using a ref keeps the connection effect from
  // re-running when the listener set changes.
  const listeners = useRef<Set<Listener>>(new Set());

  useEffect(() => {
    // same-origin; cookies (ds_session) flow automatically.
    const es = new EventSource("/api/v1/stream");
    const handlers: Array<[StreamTopic, (e: MessageEvent) => void]> = [];

    for (const topic of TOPICS) {
      const onMessage = (e: MessageEvent) => {
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

  return <StreamContext.Provider value={{ subscribe }}>{children}</StreamContext.Provider>;
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
