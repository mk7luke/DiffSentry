import net from "node:net";
import dns from "node:dns/promises";
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

// Read lazily (not a module-load const) so tests/harnesses can set the env
// before the first validation call. (See validateWebhookUrl below for the policy.)
function allowInsecureWebhooks(): boolean {
  return process.env.NODE_ENV === "test" || process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS === "true";
}

/** Is a dotted-quad IPv4 in a loopback/private/link-local/reserved range?
 *  A malformed value is treated as private (fail closed). */
function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8 "this network" / unspecified
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast + reserved
  );
}

/** Is an IPv6 literal loopback/unique-local/link-local/multicast — or an
 *  IPv4-mapped/-embedded address whose embedded IPv4 is private? */
function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) dotted forms.
  const dotted = lower.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return ipv4IsPrivate(dotted[1]);
  // IPv4-mapped in hex form (::ffff:7f00:0001).
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const embedded = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
    return ipv4IsPrivate(embedded);
  }
  return (
    lower === "::" || // unspecified
    lower === "::1" || // loopback
    /^f[cd][0-9a-f]{2}:/.test(lower) || // fc00::/7 unique-local
    /^fe[89ab][0-9a-f]:/.test(lower) || // fe80::/10 link-local
    lower.startsWith("ff") // multicast
  );
}

/** Block a host that is itself a private/loopback IP literal (any family) or
 *  localhost. Returns false for plain hostnames (those are resolved separately). */
function hostLiteralIsPrivate(host: string): boolean {
  if (host === "localhost") return true;
  const fam = net.isIP(host);
  if (fam === 4) return ipv4IsPrivate(host);
  if (fam === 6) return ipv6IsPrivate(host);
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

/**
 * Validate an outbound webhook URL the server will later POST to. It is a stored
 * egress target (SSRF surface), so by default we require `https` and reject any
 * loopback / private / link-local / reserved destination — including IPv4-mapped
 * IPv6 literals and **hostnames that resolve** to such addresses (a DNS lookup is
 * performed and every returned address is checked). Plain-http + local targets
 * are allowed only behind an explicit env flag (smoke tests / intentional
 * self-hosted internal relays). Returns an error string, or null.
 *
 * Note: validation-time resolution narrows but cannot fully eliminate DNS-
 * rebinding (the name could be re-pointed between save and send); fully closing
 * that needs a connect-time address check in the HTTP client. Given the route is
 * admin + CSRF gated and the flag exists for internal use, this is the
 * proportionate boundary; see the reply on PR #39 thread.
 */
async function validateWebhookUrl(v: string): Promise<string | null> {
  const allowInsecure = allowInsecureWebhooks();
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "A valid webhook URL is required.";
  }
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    return "Webhook URLs must use https.";
  }
  // Escape hatch (test / self-hosted internal relays): skip the egress checks.
  if (allowInsecure) return null;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) || host === "localhost") {
    return hostLiteralIsPrivate(host)
      ? "Webhook URLs may not target local or private network addresses."
      : null;
  }
  // Hostname: resolve and reject if ANY result is a private/loopback address.
  try {
    const results = await dns.lookup(host, { all: true });
    if (results.length === 0) return "Webhook host did not resolve.";
    for (const r of results) {
      const priv = r.family === 6 ? ipv6IsPrivate(r.address) : ipv4IsPrivate(r.address);
      if (priv) return "Webhook URLs may not resolve to local or private network addresses.";
    }
  } catch {
    return "Webhook host did not resolve.";
  }
  return null;
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
      const error = await validateWebhookUrl(webhookUrl);
      if (error) return { error };
      return { config: { webhookUrl } };
    }
    case "webhook": {
      const url = str("url");
      const error = await validateWebhookUrl(url);
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
