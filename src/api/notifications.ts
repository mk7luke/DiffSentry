import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { logger } from "../logger.js";
import { bus } from "../realtime/bus.js";
import {
  insertAuditLog,
  insertNotificationChannel,
  updateNotificationChannel,
  deleteNotificationChannel,
  insertAlertRule,
  updateAlertRule,
  deleteAlertRule,
} from "../storage/dao.js";
import {
  getAlertRules,
  getNotificationChannels,
  getNotificationDeliveries,
  type AlertRuleRow,
  type NotificationChannelRow,
} from "../dashboard/queries.js";
import { CHANNEL_TYPES, isChannelType, redactChannelConfig } from "../notify/channels.js";
import { checkWebhookUrlSafe } from "../notify/ssrf.js";
import { sendTest } from "../notify/engine.js";

// ─────────────────────────────────────────────────────────────────────────────
// Notification settings API — manage channels + alert rules, send a test, and
// read recent deliveries. Admin-gated end to end (same sensitivity as the audit
// log: channel configs hold webhook URLs / SMTP recipients). Every write follows
// the command-center contract: requireRole('admin') + CSRF + audit_log row +
// a config.changed bus event so other dashboards refresh.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationDeps {
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
}

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Reject a provided non-boolean `enabled` with a 400. Returns true if it did. */
function rejectNonBoolEnabled(res: Response, body: Record<string, unknown>): boolean {
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    sendError(res, 400, "bad_request", "enabled must be a boolean.");
    return true;
  }
  return false;
}

/** Hop-by-hop / request-controlled headers a stored webhook config must not set. */
const FORBIDDEN_WEBHOOK_HEADERS = new Set([
  "host",
  "content-length",
  "content-type", // the adapter sets this itself
  "connection",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

/**
 * Validate custom webhook headers before storing them. Only valid HTTP token
 * header names with single-line string values are accepted, and hop-by-hop /
 * request-controlled headers are rejected (they'd corrupt the outbound request
 * or could be abused). Returns the cleaned map, {} when absent, or an error.
 */
function validateWebhookHeaders(raw: unknown): { headers?: Record<string, string> } | { error: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "headers must be an object." };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || FORBIDDEN_WEBHOOK_HEADERS.has(name.toLowerCase())) {
      return { error: `Unsupported webhook header: ${name}.` };
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      return { error: `Webhook header ${name} must be a single-line string.` };
    }
    headers[name] = value;
  }
  return { headers };
}

/** Validate a channel config for its type. Returns the cleaned config or an error.
 *  Async because webhook URL validation may perform a DNS lookup (SSRF guard). */
async function validateChannelConfig(
  type: string,
  config: unknown,
): Promise<{ config: Record<string, unknown> } | { error: string }> {
  const c = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
  switch (type) {
    case "slack":
    case "discord": {
      const webhookUrl = str("webhookUrl");
      const error = await checkWebhookUrlSafe(webhookUrl);
      if (error) return { error };
      return { config: { webhookUrl } };
    }
    case "webhook": {
      const url = str("url");
      const error = await checkWebhookUrlSafe(url);
      if (error) return { error };
      const out: Record<string, unknown> = { url };
      const validatedHeaders = validateWebhookHeaders(c.headers);
      if ("error" in validatedHeaders) return { error: validatedHeaders.error };
      if (validatedHeaders.headers) out.headers = validatedHeaders.headers;
      return { config: out };
    }
    case "email": {
      const to = str("to");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { error: "A valid recipient email (to) is required." };
      return { config: { to } };
    }
    default:
      return { error: `Unknown channel type. Use one of: ${CHANNEL_TYPES.join(", ")}.` };
  }
}

/** Validate an alert-rule condition object. */
function validateCondition(raw: unknown): { condition: Record<string, unknown> } | { error: string } {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const event = c.event;
  const allowed = ["finding", "review_failed", "budget", "digest", "any"];
  if (typeof event !== "string" || !allowed.includes(event)) {
    return { error: `condition.event must be one of: ${allowed.join(", ")}.` };
  }
  const out: Record<string, unknown> = { event };
  if (event === "finding" && c.minSeverity !== undefined) {
    const sev = c.minSeverity;
    if (sev !== null && !["critical", "major", "minor", "nit"].includes(sev as string)) {
      return { error: "condition.minSeverity must be critical, major, minor, or nit." };
    }
    if (sev) out.minSeverity = sev;
  }
  return { condition: out };
}

/** Shape a channel row for the API (config redacted; enabled as boolean). */
function publicChannel(row: NotificationChannelRow): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  try {
    config = row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {};
  } catch {
    config = {};
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled === 1,
    config: redactChannelConfig(row.type, config),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function publicRule(row: AlertRuleRow): Record<string, unknown> {
  let condition: Record<string, unknown> = {};
  try {
    condition = row.condition_json ? (JSON.parse(row.condition_json) as Record<string, unknown>) : {};
  } catch {
    condition = {};
  }
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    condition,
    channel_id: row.channel_id,
    enabled: row.enabled === 1,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function audit(req: Request, action: string, targetRef: string | null, payload: unknown, result: "ok" | "error"): void {
  const actor = getActor(req);
  insertAuditLog({
    actorLogin: actor?.login ?? null,
    actorRole: actor?.role ?? null,
    action,
    targetType: "notification",
    targetRef,
    payload,
    result,
  });
}

function announce(req: Request, kind: string, op: string): void {
  const actor = getActor(req);
  bus.publish("config.changed", { kind, op, actor: actor?.login ?? null });
}

/** Register the notification settings endpoints (admin-gated) on the API router. */
export function registerNotificationRoutes(router: Router, deps: NotificationDeps): void {
  const { requireRole, csrf } = deps;
  const admin = requireRole("admin");

  // ── Read everything the Notifications screen needs ──────────────────
  router.get("/notifications", admin, (_req, res) => {
    try {
      sendData(res, {
        channels: getNotificationChannels().map(publicChannel),
        rules: getAlertRules().map(publicRule),
        deliveries: getNotificationDeliveries(50),
        channelTypes: CHANNEL_TYPES,
        eventTypes: ["finding", "review_failed", "budget", "digest", "any"],
      });
    } catch (err) {
      logger.error({ err }, "api GET /notifications failed");
      sendError(res, 500, "internal", "Failed to load notifications.");
    }
  });

  // ── Create a channel ────────────────────────────────────────────────
  router.post("/notifications/channels", admin, csrf.verify, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (rejectNonBoolEnabled(res, body)) return;
    const type = typeof body.type === "string" ? body.type : "";
    if (!isChannelType(type)) {
      sendError(res, 400, "bad_request", `type must be one of: ${CHANNEL_TYPES.join(", ")}.`);
      return;
    }
    const validated = await validateChannelConfig(type, body.config);
    if ("error" in validated) {
      sendError(res, 400, "bad_request", validated.error);
      return;
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    try {
      const id = insertNotificationChannel({
        type,
        name,
        config: validated.config,
        enabled: body.enabled !== false,
        createdBy: getActor(req)?.login ?? null,
      });
      if (id == null) {
        sendError(res, 500, "internal", "Persistence is disabled — cannot save channels.");
        return;
      }
      audit(req, "notification.channel.create", `channel#${id}`, { type, name }, "ok");
      announce(req, "channel", "create");
      sendData(res, { id, type, name }, 201);
    } catch (err) {
      logger.error({ err }, "api POST /notifications/channels failed");
      sendError(res, 500, "internal", "Failed to create channel.");
    }
  });

  // ── Update a channel (name / config / enabled) ──────────────────────
  router.put("/notifications/channels/:id", admin, csrf.verify, async (req, res) => {
    const id = parseId(String(req.params.id));
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid channel id.");
      return;
    }
    const existing = getNotificationChannels().find((c) => c.id === id);
    if (!existing) {
      sendError(res, 404, "not_found", "Channel not found.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (rejectNonBoolEnabled(res, body)) return;
    const patch: { id: number; name?: string | null; config?: unknown; enabled?: boolean } = { id };
    if (body.name !== undefined) patch.name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
    if (body.config !== undefined) {
      const validated = await validateChannelConfig(existing.type, body.config);
      if ("error" in validated) {
        sendError(res, 400, "bad_request", validated.error);
        return;
      }
      patch.config = validated.config;
    }
    try {
      const changed = updateNotificationChannel(patch);
      audit(req, "notification.channel.update", `channel#${id}`, { fields: Object.keys(patch).filter((k) => k !== "id") }, changed ? "ok" : "error");
      // Only announce a real mutation — a no-op update shouldn't refresh dashboards.
      if (changed) announce(req, "channel", "update");
      sendData(res, { id, changed });
    } catch (err) {
      logger.error({ err, id }, "api PUT /notifications/channels failed");
      sendError(res, 500, "internal", "Failed to update channel.");
    }
  });

  // ── Delete a channel ────────────────────────────────────────────────
  router.delete("/notifications/channels/:id", admin, csrf.verify, (req, res) => {
    const id = parseId(String(req.params.id));
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid channel id.");
      return;
    }
    try {
      const deleted = deleteNotificationChannel(id);
      if (!deleted) {
        sendError(res, 404, "not_found", "Channel not found.");
        return;
      }
      audit(req, "notification.channel.delete", `channel#${id}`, undefined, "ok");
      announce(req, "channel", "delete");
      sendData(res, { id, deleted });
    } catch (err) {
      logger.error({ err, id }, "api DELETE /notifications/channels failed");
      sendError(res, 500, "internal", "Failed to delete channel.");
    }
  });

  // ── Send a test message to a channel ────────────────────────────────
  router.post("/notifications/channels/:id/test", admin, csrf.verify, async (req, res) => {
    const id = parseId(String(req.params.id));
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid channel id.");
      return;
    }
    try {
      const actor = getActor(req);
      const result = await sendTest(id, actor?.login ?? null);
      audit(req, "notification.channel.test", `channel#${id}`, { detail: result.detail }, result.ok ? "ok" : "error");
      if (!result.ok && result.detail === "channel not found") {
        sendError(res, 404, "not_found", "Channel not found.");
        return;
      }
      // The send itself may have failed (bad webhook) — report that in the body,
      // not as an HTTP error, so the UI can show the channel's actual response.
      sendData(res, { id, ok: result.ok, detail: result.detail });
    } catch (err) {
      logger.error({ err, id }, "api POST /notifications/channels/:id/test failed");
      sendError(res, 500, "internal", "Failed to send test.");
    }
  });

  // ── Create a rule ───────────────────────────────────────────────────
  router.post("/notifications/rules", admin, csrf.verify, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (rejectNonBoolEnabled(res, body)) return;
    const validated = validateCondition(body.condition);
    if ("error" in validated) {
      sendError(res, 400, "bad_request", validated.error);
      return;
    }
    const channelId = typeof body.channelId === "number" ? body.channelId : parseId(String(body.channelId ?? ""));
    if (channelId == null) {
      sendError(res, 400, "bad_request", "A channelId is required.");
      return;
    }
    // Reject up front so a non-existent channel returns a clean 400 rather than
    // tripping the FK constraint inside insertAlertRule (which surfaces as a 500).
    if (!getNotificationChannels().some((c) => c.id === channelId)) {
      sendError(res, 400, "bad_request", "channelId does not match an existing channel.");
      return;
    }
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "global";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    try {
      const id = insertAlertRule({
        name,
        scope,
        condition: validated.condition,
        channelId,
        enabled: body.enabled !== false,
        createdBy: getActor(req)?.login ?? null,
      });
      if (id == null) {
        sendError(res, 500, "internal", "Persistence is disabled — cannot save rules.");
        return;
      }
      audit(req, "notification.rule.create", `rule#${id}`, { scope, condition: validated.condition, channelId }, "ok");
      announce(req, "rule", "create");
      sendData(res, { id }, 201);
    } catch (err) {
      logger.error({ err }, "api POST /notifications/rules failed");
      sendError(res, 500, "internal", "Failed to create rule.");
    }
  });

  // ── Update a rule ───────────────────────────────────────────────────
  router.put("/notifications/rules/:id", admin, csrf.verify, (req, res) => {
    const id = parseId(String(req.params.id));
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid rule id.");
      return;
    }
    const existing = getAlertRules().find((r) => r.id === id);
    if (!existing) {
      sendError(res, 404, "not_found", "Rule not found.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (rejectNonBoolEnabled(res, body)) return;
    const patch: { id: number; name?: string | null; scope?: string; condition?: unknown; channelId?: number | null; enabled?: boolean } = { id };
    if (body.name !== undefined) patch.name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (body.scope !== undefined) patch.scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "global";
    if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
    if (body.channelId !== undefined) {
      const cid = typeof body.channelId === "number" ? body.channelId : parseId(String(body.channelId));
      // A supplied channelId must be valid + existing — never silently unset the
      // rule's channel (or write an FK-violating id) from a bad value.
      if (cid == null || !getNotificationChannels().some((c) => c.id === cid)) {
        sendError(res, 400, "bad_request", "channelId must reference an existing channel.");
        return;
      }
      patch.channelId = cid;
    }
    if (body.condition !== undefined) {
      const validated = validateCondition(body.condition);
      if ("error" in validated) {
        sendError(res, 400, "bad_request", validated.error);
        return;
      }
      patch.condition = validated.condition;
    }
    try {
      const changed = updateAlertRule(patch);
      audit(req, "notification.rule.update", `rule#${id}`, { fields: Object.keys(patch).filter((k) => k !== "id") }, changed ? "ok" : "error");
      // Only announce a real mutation — a no-op update shouldn't refresh dashboards.
      if (changed) announce(req, "rule", "update");
      sendData(res, { id, changed });
    } catch (err) {
      logger.error({ err, id }, "api PUT /notifications/rules failed");
      sendError(res, 500, "internal", "Failed to update rule.");
    }
  });

  // ── Delete a rule ───────────────────────────────────────────────────
  router.delete("/notifications/rules/:id", admin, csrf.verify, (req, res) => {
    const id = parseId(String(req.params.id));
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid rule id.");
      return;
    }
    try {
      const deleted = deleteAlertRule(id);
      if (!deleted) {
        sendError(res, 404, "not_found", "Rule not found.");
        return;
      }
      audit(req, "notification.rule.delete", `rule#${id}`, undefined, "ok");
      announce(req, "rule", "delete");
      sendData(res, { id, deleted });
    } catch (err) {
      logger.error({ err, id }, "api DELETE /notifications/rules failed");
      sendError(res, 500, "internal", "Failed to delete rule.");
    }
  });
}
