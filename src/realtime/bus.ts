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

/** A review produced findings — emitted once per completed review (after the
 *  findings are persisted), carrying a per-severity breakdown so the alert
 *  engine can match rules like "critical finding in repo X". */
export interface FindingSurfacedPayload {
  owner: string;
  repo: string;
  number: number;
  /** Total findings across this review. */
  total: number;
  /** Count by severity bucket (0 when absent). */
  critical: number;
  major: number;
  minor: number;
  nit: number;
  /** Highest severity present, or null when none. */
  worst: "critical" | "major" | "minor" | "nit" | null;
  /** Title of a representative (highest-severity) finding, for the message. */
  sample?: string | null;
}

/** A notification was dispatched (or failed) to a channel. Emitted by the alert
 *  engine so the Notifications screen's "recent deliveries" updates live. */
export interface NotificationDeliveredPayload {
  channelId: number | null;
  channelType: string | null;
  channelName: string | null;
  ruleName: string | null;
  trigger: string;
  target: string;
  status: "ok" | "error";
  detail?: string;
}

/** Command-center configuration changed (channel/rule created, edited, removed).
 *  Emitted by the admin write endpoints so other connected dashboards refresh. */
export interface ConfigChangedPayload {
  /** What kind of config changed, e.g. "channel" | "rule". */
  kind: string;
  /** The mutation, e.g. "create" | "update" | "delete". */
  op: string;
  actor: string | null;
}

/** Instance settings changed (e.g. branding) — emitted from the admin write
 * endpoint so every connected dashboard can re-brand live without a refresh. */
export interface SettingsUpdatedPayload {
  /** Resolved instance name after the change. */
  instanceName: string;
  /** Resolved accent color (hex) after the change. */
  accentColor: string;
  /** The admin who made the change, if known. */
  updatedBy: string | null;
}

/** AI-spend budget exceeded — emitted from the cost instrumentation. */
export interface BudgetAlertPayload {
  /** 'global' or 'owner/repo'. */
  scope: string;
  owner: string | null;
  repo: string | null;
  /** YYYY-MM the alert is for. */
  month: string;
  /** Month-to-date spend that tripped the budget. */
  spentUsd: number;
  /** The configured monthly ceiling. */
  budgetUsd: number;
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

/** An API token was created or revoked — emitted from the token admin API. */
export interface TokenChangePayload {
  id: number;
  name: string | null;
  /** "create" | "revoke". */
  action: "create" | "revoke";
  actor: string | null;
  role: string | null;
  /** "ok" | "noop" | "error". */
  result: string;
}

/** A custom anti-pattern rule was created, updated, or deleted via the API. */
export interface RuleChangedPayload {
  /** The rule id (null only when a delete raced a missing row). */
  id: number | null;
  name: string;
  scope: string;
  action: "create" | "update" | "delete";
  actor: string | null;
  role: string | null;
}

/** A repo's .diffsentry.yaml was changed from the command center. */
export interface ConfigUpdatePayload {
  owner: string;
  repo: string;
  /** How the change landed: a direct commit on the default branch, or a PR. */
  mode: "commit" | "pr";
  actor: string | null;
  role: string | null;
  /** Branch the change targeted (default branch for "commit", the PR head for "pr"). */
  branch: string;
  /** Commit SHA for a direct commit. */
  commitSha?: string;
  /** PR number + URL when mode === "pr". */
  prNumber?: number;
  prUrl?: string;
}

/** A learning was created / edited / deleted / promoted — emitted from the API
 * so connected dashboards refresh the Learnings screen without a manual reload. */
export interface LearningChangePayload {
  /** Which store changed. */
  scope: "global" | "repo";
  /** Present for repo-scoped changes (owner/name of the affected repo). */
  owner?: string;
  repo?: string;
  /** Bare action name: "create" | "update" | "delete" | "promote" | "bulk_delete". */
  action: string;
  /** The affected learning id, when a single one changed. */
  id?: string;
  /** Number affected (bulk_delete). */
  count?: number;
  actor: string | null;
  role: string | null;
}

/** The state machine behind the review-pipeline board. */
export type ReviewQueueState = "queued" | "running" | "done" | "failed" | "canceled";

/**
 * A single review's lifecycle as tracked by the in-memory queue registry
 * (src/realtime/queue.ts). Published verbatim as `queue.updated` and returned
 * by GET /api/v1/queue. Fully JSON-serializable — the AbortController that
 * actually drives cancellation is held out-of-band by the registry.
 */
export interface ReviewQueueEntry {
  /** `${owner}/${repo}#${number}` — stable per PR across attempts. */
  key: string;
  owner: string;
  repo: string;
  number: number;
  mode: "full" | "incremental";
  state: ReviewQueueState;
  /** Free-text phase shown on the running card (e.g. "reviewing"). */
  phase: string | null;
  /** ISO time the review entered the queue. */
  enqueuedAt: string;
  /** ISO time it transitioned to running (null while still queued). */
  startedAt: string | null;
  /** ISO time it reached a terminal state (null while active). */
  finishedAt: string | null;
  /** Error message for the failed lane (never a stack trace). */
  error: string | null;
  /** Monotonic per-PR attempt counter — bumped on each (re-)enqueue. */
  attempt: number;
}

/** An admin replayed a stored webhook delivery — emitted from the API. */
export interface WebhookReplayPayload {
  /** rowid of the original delivery that was replayed. */
  id: number;
  /** rowid of the new delivery row recorded for the replay (null if DB off). */
  newDeliveryId: number | null;
  event: string;
  action: string | null;
  actor: string | null;
}

/** Topic → payload map. Add new topics here so publish/subscribe stay typed. */
export interface BusEventMap {
  "review.started": ReviewLifecyclePayload;
  "review.finished": ReviewLifecyclePayload;
  "review.failed": ReviewLifecyclePayload;
  "action.performed": ActionPayload;
  "finding.surfaced": FindingSurfacedPayload;
  "notification.delivered": NotificationDeliveredPayload;
  "config.changed": ConfigChangedPayload;
  "settings.updated": SettingsUpdatedPayload;
  "budget.exceeded": BudgetAlertPayload;
  "settings.changed": SettingsChangedPayload;
  "token.changed": TokenChangePayload;
  "rule.changed": RuleChangedPayload;
  "config.updated": ConfigUpdatePayload;
  "learning.changed": LearningChangePayload;
  "queue.updated": ReviewQueueEntry;
  "webhook.replayed": WebhookReplayPayload;
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

/** Process-wide singleton. Import this everywhere — do not construct your own.
 * Pinned to globalThis so the instance survives any module-duplication a
 * bundler/loader might introduce (a no-op in the normal single-graph runtime);
 * this keeps publishers and the SSE subscriber on the same bus. */
const busGlobal = globalThis as unknown as { __diffsentryBus?: EventBus };
export const bus: EventBus = busGlobal.__diffsentryBus ?? (busGlobal.__diffsentryBus = new EventBus());
