import { EventEmitter } from "node:events";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-process event bus — the command-center's realtime substrate.
//
// Every mutating action and the review lifecycle publish here; the SSE endpoint
// (src/api/stream.ts) is the only subscriber in production, fanning each event
// out to connected dashboards. It is a thin, typed wrapper over Node's
// EventEmitter plus a small ring buffer so a client that reconnects with a
// Last-Event-ID can be replayed the handful of events it missed.
//
// Single process / single container: there is no cross-instance delivery here.
// If DiffSentry is ever scaled horizontally this becomes a per-instance bus and
// would need a shared backplane — out of scope for the single-container design.
// ─────────────────────────────────────────────────────────────────────────────

/** Review lifecycle event — emitted from reviewer.handlePullRequest. */
export interface ReviewLifecyclePayload {
  owner: string;
  repo: string;
  number: number;
  mode?: "full" | "incremental";
  /** Present on review.failed — the error message (never the stack). */
  error?: string;
}

/** A role-gated write action completed (or failed) — emitted from the API. */
export interface ActionPayload {
  owner: string;
  repo: string;
  number: number;
  /** Bare action name, e.g. "review", "resolve", "pause", "resume", "cancel". */
  action: string;
  actor: string | null;
  role: string | null;
  /** "ok" | "error" — mirrors the audit_log result column. */
  result: string;
  /** Optional human-readable detail (e.g. the mode, or an error message). */
  detail?: string;
}

/** An operator settings override changed — emitted from the settings API. */
export interface SettingsChangedPayload {
  /** 'global' or 'owner/repo'. */
  scope: string;
  /** The setting key that changed (e.g. "pauseAll", "profile"). */
  key: string;
  /** The new value, or null when the override was cleared. */
  value: unknown;
  actor: string | null;
}

/** Topic → payload map. Add new topics here so publish/subscribe stay typed. */
export interface BusEventMap {
  "review.started": ReviewLifecyclePayload;
  "review.finished": ReviewLifecyclePayload;
  "review.failed": ReviewLifecyclePayload;
  "action.performed": ActionPayload;
  "settings.changed": SettingsChangedPayload;
}

export type BusTopic = keyof BusEventMap;

/** The envelope delivered to subscribers and serialized over SSE. */
export interface BusEnvelope<T extends BusTopic = BusTopic> {
  /** Monotonic per-process id — the SSE `id:` field + Last-Event-ID cursor. */
  id: number;
  /** ISO-8601 publish time. */
  ts: string;
  topic: T;
  payload: BusEventMap[T];
}

// Single internal channel carrying the envelope; topic lives inside it. Keeps
// listener bookkeeping to one add/remove regardless of how many topics exist.
const CHANNEL = "event";
// How many recent events to retain for Last-Event-ID replay. Small on purpose:
// this is a best-effort reconnection aid, not durable history (that's the DB).
const RING_SIZE = 256;

class EventBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;
  private ring: BusEnvelope[] = [];

  constructor() {
    // One listener per connected SSE client; lift the default-10 cap so a
    // busy dashboard fleet doesn't trip the EventEmitter leak warning.
    this.emitter.setMaxListeners(0);
  }

  /** Publish an event. Never throws — a misbehaving subscriber is swallowed. */
  publish<T extends BusTopic>(topic: T, payload: BusEventMap[T]): BusEnvelope<T> {
    const env: BusEnvelope<T> = {
      id: ++this.seq,
      ts: new Date().toISOString(),
      topic,
      payload,
    };
    this.ring.push(env);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    try {
      this.emitter.emit(CHANNEL, env);
    } catch (err) {
      logger.debug({ err, topic }, "bus.publish: subscriber threw");
    }
    return env;
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: (env: BusEnvelope) => void): () => void {
    this.emitter.on(CHANNEL, listener);
    return () => {
      this.emitter.off(CHANNEL, listener);
    };
  }

  /** Buffered events strictly newer than `afterId` (Last-Event-ID replay). */
  replayAfter(afterId: number): BusEnvelope[] {
    if (!Number.isFinite(afterId) || afterId <= 0) return [];
    return this.ring.filter((e) => e.id > afterId);
  }

  /** The id of the most recently published event (0 if none yet). */
  lastId(): number {
    return this.seq;
  }
}

/** Process-wide singleton. Import this everywhere — do not construct your own. */
export const bus = new EventBus();
