import { bus, type BusEnvelope } from "../realtime/bus.js";
import { logger } from "../logger.js";
import {
  getAlertRules,
  getNotificationChannel,
  getNotificationChannels,
  getWeeklyDigest,
  type AlertRuleRow,
  type NotificationChannelRow,
} from "../dashboard/queries.js";
import { recordNotificationDelivery, getSettingOverride, upsertSettingOverride } from "../storage/dao.js";
import { deliverToChannel, type ChannelMessage } from "./channels.js";
import {
  renderBudgetMessage,
  renderDigestMessage,
  renderFindingMessage,
  renderReviewFailedMessage,
  severityRank,
} from "./messages.js";

// ─────────────────────────────────────────────────────────────────────────────
// Alert engine — subscribes to the in-process bus and fans matching events out
// to the configured channels, recording every delivery. Also runs a weekly
// digest timer (rules with event "digest"). Budget alerts are consumed from the
// cost feature's `budget.exceeded` event (it owns the DB-configured budgets) —
// the engine just delivers them to the matching channels.
//
// Everything is best-effort: the engine never throws into a bus handler, and it
// degrades to a no-op when persistence is off (no rules/channels to read).
// ─────────────────────────────────────────────────────────────────────────────

export type AlertEventType = "finding" | "review_failed" | "budget" | "digest" | "any";

export interface RuleCondition {
  event: AlertEventType;
  /** Findings only: fire only at/above this severity. Defaults to "nit" (any). */
  minSeverity?: "critical" | "major" | "minor" | "nit";
}

/** Bus topics the engine reacts to → the rule event type they map to. */
const TOPIC_EVENT: Partial<Record<BusEnvelope["topic"], AlertEventType>> = {
  "finding.surfaced": "finding",
  "review.failed": "review_failed",
  "budget.exceeded": "budget",
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseCondition(row: AlertRuleRow): RuleCondition {
  const c = parseJson<Partial<RuleCondition>>(row.condition_json, {});
  const event: AlertEventType =
    c.event === "review_failed" || c.event === "budget" || c.event === "digest" || c.event === "any"
      ? c.event
      : "finding";
  // Validate minSeverity defensively (a malformed/legacy row could carry junk);
  // an unrecognized value is dropped so onEvent falls back to the "nit" floor.
  const minSeverity =
    c.minSeverity === "critical" || c.minSeverity === "major" || c.minSeverity === "minor" || c.minSeverity === "nit"
      ? c.minSeverity
      : undefined;
  return { event, minSeverity };
}

function channelConfig(row: NotificationChannelRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(row.config_json, {});
}

/** Does an event for (owner/repo) fall within a rule's scope? A null/empty/
 *  "global" scope matches everything; otherwise it must equal "owner/repo". */
function scopeMatches(scope: string | null, owner?: string, repo?: string): boolean {
  const s = (scope ?? "").trim();
  if (s === "" || s === "global") return true;
  if (!owner || !repo) return false;
  return s === `${owner}/${repo}`;
}

export interface DispatchMeta {
  trigger: string;
  target: string;
  ruleId?: number | null;
  ruleName?: string | null;
}

/**
 * Deliver one message to one channel, record the delivery, and publish a
 * notification.delivered bus event. Returns the delivery result.
 */
export async function dispatchToChannel(
  channel: NotificationChannelRow,
  msg: ChannelMessage,
  meta: DispatchMeta,
): Promise<{ ok: boolean; detail: string }> {
  const result = await deliverToChannel({ type: channel.type, config: channelConfig(channel) }, msg);
  recordNotificationDelivery({
    channelId: channel.id,
    channelType: channel.type,
    channelName: channel.name,
    ruleId: meta.ruleId ?? null,
    ruleName: meta.ruleName ?? null,
    trigger: meta.trigger,
    target: meta.target,
    title: msg.title,
    status: result.ok ? "ok" : "error",
    detail: result.detail,
  });
  bus.publish("notification.delivered", {
    channelId: channel.id,
    channelType: channel.type,
    channelName: channel.name,
    ruleName: meta.ruleName ?? null,
    trigger: meta.trigger,
    target: meta.target,
    status: result.ok ? "ok" : "error",
    detail: result.detail,
  });
  return result;
}

/** Send a test message to one channel by id. Returns the result (or a reason). */
export async function sendTest(channelId: number, actorLogin?: string | null): Promise<{ ok: boolean; detail: string }> {
  const channel = getNotificationChannel(channelId);
  if (!channel) return { ok: false, detail: "channel not found" };
  const msg: ChannelMessage = {
    title: "DiffSentry test notification",
    text: `This is a test from DiffSentry${actorLogin ? `, sent by @${actorLogin}` : ""}. If you can see this, the channel is wired up correctly.`,
    severity: "info",
    fields: [{ label: "Channel", value: channel.name ?? channel.type }],
  };
  return dispatchToChannel(channel, msg, { trigger: "test", target: "—" });
}

function dashboardOrigin(): string | undefined {
  const raw = (process.env.DASHBOARD_URL ?? "").trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** ISO-week key "YYYY-Www" used to dedupe the weekly digest across restarts. */
function isoWeekKey(d: Date): string {
  // Copy to a UTC date at the week's Thursday (ISO week rule).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

class NotificationEngine {
  private unsub: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];

  start(): void {
    if (this.unsub) return; // already started
    this.unsub = bus.subscribe((env) => {
      const eventType = TOPIC_EVENT[env.topic];
      if (!eventType) return;
      void this.onEvent(eventType, env);
    });
    // Hourly tick drives the (time-gated) weekly digest. The handle is stored in
    // this.timers and cleared in stop().
    const tick = setInterval(() => void this.tick(), 60 * 60 * 1000);
    if (typeof tick.unref === "function") tick.unref();
    this.timers.push(tick);
    // Run one tick immediately so a process that boots during the digest window
    // doesn't wait up to an hour to evaluate it. Fire-and-forget; tick() catches
    // its own errors so this never throws out of start().
    void this.tick();
    logger.info("Notification engine started (bus subscriber + hourly digest tick)");
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async onEvent(eventType: AlertEventType, env: BusEnvelope): Promise<void> {
    try {
      const payload = env.payload as unknown as Record<string, unknown>;
      const owner = typeof payload.owner === "string" ? payload.owner : undefined;
      const repo = typeof payload.repo === "string" ? payload.repo : undefined;
      const rules = getAlertRules().filter((r) => r.enabled === 1);
      if (rules.length === 0) return;
      const channels = new Map(getNotificationChannels().map((c) => [c.id, c]));

      const msg = this.renderForEvent(eventType, env);
      if (!msg) return;
      const target =
        owner && repo
          ? `${owner}/${repo}${typeof payload.number === "number" ? `#${payload.number}` : ""}`
          : typeof payload.scope === "string"
            ? payload.scope
            : "—";

      for (const rule of rules) {
        const cond = parseCondition(rule);
        if (cond.event !== eventType && cond.event !== "any") continue;
        if (!scopeMatches(rule.scope, owner, repo)) continue;
        // Severity floor for finding events.
        if (eventType === "finding") {
          const floor = cond.minSeverity ?? "nit";
          const worst = typeof payload.worst === "string" ? payload.worst : null;
          if (severityRank(worst) < severityRank(floor)) continue;
        }
        if (rule.channel_id == null) continue;
        const channel = channels.get(rule.channel_id);
        if (!channel || channel.enabled !== 1) continue;
        await dispatchToChannel(channel, msg, {
          trigger: eventType,
          target,
          ruleId: rule.id,
          ruleName: rule.name,
        });
      }
    } catch (err) {
      logger.debug({ err, eventType }, "notification engine: onEvent failed");
    }
  }

  private renderForEvent(eventType: AlertEventType, env: BusEnvelope): ChannelMessage | null {
    switch (eventType) {
      case "finding":
        return renderFindingMessage(env.payload as never);
      case "review_failed":
        return renderReviewFailedMessage(env.payload as never);
      case "budget":
        return renderBudgetMessage(env.payload as never);
      default:
        return null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.maybeSendDigest();
    } catch (err) {
      logger.debug({ err }, "notification engine: tick failed");
    }
  }

  /** Send the weekly digest if it's the configured weekday+hour (UTC) and this
   *  ISO week hasn't been sent yet (persisted so restarts don't double-send). */
  private async maybeSendDigest(): Promise<void> {
    if (process.env.NOTIFY_DIGEST_DISABLED === "1") return;
    // Date#getUTCDay() is numbered 0=Sun … 6=Sat, so the valid range is 0–6.
    const defaultDigestDay = 1; // Monday
    const day = clampInt(process.env.NOTIFY_DIGEST_DAY, defaultDigestDay, 0, 6);
    const hour = clampInt(process.env.NOTIFY_DIGEST_HOUR, 9, 0, 23);
    const now = new Date();
    if (now.getUTCDay() !== day || now.getUTCHours() !== hour) return;

    const weekKey = isoWeekKey(now);
    const lastSent = getSettingOverride<string>("global", "digest.lastSentWeek");
    if (lastSent === weekKey) return;

    const digestRules = getAlertRules().filter((r) => r.enabled === 1 && parseCondition(r).event === "digest");
    if (digestRules.length === 0) {
      // Still mark the week so we don't re-evaluate every hour today.
      upsertSettingOverride({ scope: "global", key: "digest.lastSentWeek", value: weekKey, updatedBy: "system" });
      return;
    }
    const channels = new Map(getNotificationChannels().map((c) => [c.id, c]));
    // Each rule's digest reflects its own scope: a "global" rule gets the org-wide
    // rollup, an "owner/repo" rule gets that repo's rollup — never global data
    // mislabeled as a repo's. Cache by scope so repeated scopes compute once.
    const origin = dashboardOrigin();
    const msgByScope = new Map<string, ChannelMessage>();
    const messageFor = (scopeStr: string): ChannelMessage => {
      let m = msgByScope.get(scopeStr);
      if (!m) {
        const parts = scopeStr.split("/");
        const repoScope = parts.length === 2 && parts[0] && parts[1] ? { owner: parts[0], repo: parts[1] } : undefined;
        m = renderDigestMessage(getWeeklyDigest(7, repoScope), origin);
        msgByScope.set(scopeStr, m);
      }
      return m;
    };
    let attempted = false; // an enabled channel was found and dispatch was called
    let delivered = false; // at least one dispatch returned ok
    for (const rule of digestRules) {
      if (rule.channel_id == null) continue;
      const channel = channels.get(rule.channel_id);
      if (!channel || channel.enabled !== 1) continue;
      attempted = true;
      const scopeStr = (rule.scope ?? "").trim() || "global";
      const result = await dispatchToChannel(channel, messageFor(scopeStr), {
        trigger: "digest",
        target: scopeStr,
        ruleId: rule.id,
        ruleName: rule.name,
      });
      if (result.ok) delivered = true;
    }
    // Retry next tick ONLY when we actually tried to deliver and every attempt
    // failed — that's the transient-outage case where the week shouldn't be
    // burned. If no attempt was even possible (no enabled channel on any digest
    // rule), there's nothing to retry, so mark the week sent like the no-rules
    // case to avoid re-evaluating every hour in the window.
    if (attempted && !delivered) {
      logger.warn({ weekKey, rules: digestRules.length }, "Weekly digest: no channel accepted delivery — not marking the week sent");
      return;
    }
    upsertSettingOverride({ scope: "global", key: "digest.lastSentWeek", value: weekKey, updatedBy: "system" });
    if (delivered) {
      logger.info({ weekKey, rules: digestRules.length }, "Weekly digest sent");
    } else {
      logger.info({ weekKey, rules: digestRules.length }, "Weekly digest: no eligible channel — marked week sent without delivering");
    }
  }
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Process-wide singleton. */
export const notificationEngine = new NotificationEngine();

/** Start the alert engine (idempotent). Call once at boot. */
export function startNotifications(): void {
  notificationEngine.start();
}
