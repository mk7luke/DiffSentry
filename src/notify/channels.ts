import { logger } from "../logger.js";
import { sendMail, smtpConfigFromChannel } from "./smtp.js";
import { sendJsonPinned } from "./ssrf.js";

// ─────────────────────────────────────────────────────────────────────────────
// Channel adapters — turn a normalized ChannelMessage into a real delivery over
// Slack / Discord / a generic webhook / email (SMTP). Each adapter returns a
// DeliveryResult rather than throwing, so the alert engine can record an
// error-status delivery row instead of crashing a bus handler.
//
// HTTP adapters post via ssrf.sendJsonPinned — a node:http/https request with a
// hard timeout whose DNS resolution is pinned to a validated public address, so
// the connection can't be rebound to a private target between the safety check
// and the socket connect. Email uses the dependency-free SMTP client in
// ./smtp.ts, configured from NOTIFY_SMTP_*.
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelType = "slack" | "discord" | "webhook" | "email";

export const CHANNEL_TYPES: ChannelType[] = ["slack", "discord", "webhook", "email"];

export function isChannelType(v: unknown): v is ChannelType {
  return typeof v === "string" && (CHANNEL_TYPES as string[]).includes(v);
}

export type MessageSeverity = "critical" | "major" | "minor" | "nit" | "info";

/** Provider-agnostic message the adapters render into each platform's shape. */
export interface ChannelMessage {
  title: string;
  /** Body text (plain / lightly-marked). */
  text: string;
  severity?: MessageSeverity;
  /** A link back to the PR or dashboard. */
  url?: string;
  /** Optional key/value rows rendered as a compact list. */
  fields?: Array<{ label: string; value: string }>;
}

export interface DeliveryResult {
  ok: boolean;
  /** Short human-readable detail (HTTP status, error message, "sent"). */
  detail: string;
}

/** Hex colors for the Slack attachment bar / Discord embed stripe. */
const SEVERITY_COLOR: Record<MessageSeverity, number> = {
  critical: 0xe5484d,
  major: 0xf5a623,
  minor: 0x3b82f6,
  nit: 0x8b949e,
  info: 0x6e7681,
};

const HTTP_TIMEOUT_MS = 10_000;

function renderPlain(msg: ChannelMessage): string {
  let out = `*${msg.title}*\n${msg.text}`;
  if (msg.fields && msg.fields.length > 0) {
    out += "\n" + msg.fields.map((f) => `• ${f.label}: ${f.value}`).join("\n");
  }
  if (msg.url) out += `\n${msg.url}`;
  return out;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<DeliveryResult> {
  // SSRF protection lives in sendJsonPinned: it validates the URL up front
  // (scheme + IP-literal range + a first hostname resolve via checkWebhookUrlSafe)
  // and then pins DNS at connect time, so a host re-pointed to a private address
  // after config save (DNS rebinding) is still rejected — with no second
  // unchecked resolution. A validation failure throws `blocked: …`, surfaced as
  // the delivery detail by the catch below.
  try {
    const resp = await sendJsonPinned(url, JSON.stringify(body), headers, HTTP_TIMEOUT_MS);
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, detail: `HTTP ${resp.status}${resp.body ? `: ${resp.body.slice(0, 200)}` : ""}` };
    }
    return { ok: true, detail: `HTTP ${resp.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}

// ── Slack (incoming webhook) ────────────────────────────────────────
async function deliverSlack(config: Record<string, unknown>, msg: ChannelMessage): Promise<DeliveryResult> {
  const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl : "";
  if (!webhookUrl) return { ok: false, detail: "missing webhookUrl" };
  const color = `#${SEVERITY_COLOR[msg.severity ?? "info"].toString(16).padStart(6, "0")}`;
  const lines = [msg.text];
  if (msg.fields) for (const f of msg.fields) lines.push(`*${f.label}:* ${f.value}`);
  if (msg.url) lines.push(`<${msg.url}|Open>`);
  const payload = {
    text: msg.title,
    attachments: [{ color, title: msg.title, text: lines.join("\n"), fallback: msg.title }],
  };
  return postJson(webhookUrl, payload);
}

// ── Discord (webhook) ───────────────────────────────────────────────
async function deliverDiscord(config: Record<string, unknown>, msg: ChannelMessage): Promise<DeliveryResult> {
  const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl : "";
  if (!webhookUrl) return { ok: false, detail: "missing webhookUrl" };
  const embed = {
    title: msg.title,
    description: msg.text,
    color: SEVERITY_COLOR[msg.severity ?? "info"],
    url: msg.url,
    fields: (msg.fields ?? []).map((f) => ({ name: f.label, value: f.value, inline: true })),
  };
  return postJson(webhookUrl, { embeds: [embed] });
}

// ── Generic webhook ─────────────────────────────────────────────────
async function deliverWebhook(config: Record<string, unknown>, msg: ChannelMessage): Promise<DeliveryResult> {
  const url = typeof config.url === "string" ? config.url : "";
  if (!url) return { ok: false, detail: "missing url" };
  const headers =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, string>)
      : {};
  // Send the structured message plus a flattened text rendering for simple sinks.
  return postJson(url, { ...msg, rendered: renderPlain(msg) }, headers);
}

// ── Email (SMTP) ────────────────────────────────────────────────────
async function deliverEmail(config: Record<string, unknown>, msg: ChannelMessage): Promise<DeliveryResult> {
  const to = typeof config.to === "string" ? config.to : "";
  if (!to) return { ok: false, detail: "missing recipient (to)" };
  const smtp = smtpConfigFromChannel(config);
  if (!smtp) {
    return {
      ok: false,
      detail: "SMTP not configured (set host + from on the channel, or NOTIFY_SMTP_HOST + NOTIFY_SMTP_FROM)",
    };
  }
  const bodyLines = [msg.text];
  if (msg.fields) for (const f of msg.fields) bodyLines.push(`${f.label}: ${f.value}`);
  if (msg.url) bodyLines.push("", msg.url);
  try {
    await sendMail(smtp, { to, subject: msg.title, text: bodyLines.join("\n") });
    return { ok: true, detail: `sent to ${to}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Dispatch a message to a channel by type. Never throws. */
export async function deliverToChannel(
  channel: { type: string; config: Record<string, unknown> },
  msg: ChannelMessage,
): Promise<DeliveryResult> {
  try {
    switch (channel.type) {
      case "slack":
        return await deliverSlack(channel.config, msg);
      case "discord":
        return await deliverDiscord(channel.config, msg);
      case "webhook":
        return await deliverWebhook(channel.config, msg);
      case "email":
        return await deliverEmail(channel.config, msg);
      default:
        return { ok: false, detail: `unknown channel type: ${channel.type}` };
    }
  } catch (err) {
    logger.debug({ err, type: channel.type }, "deliverToChannel threw");
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Redact secrets from a channel config for safe return over the API. Webhook
 * URLs and SMTP recipients are config (not shown), but the *shape* (which keys
 * are set) is preserved so the UI can show "configured" without leaking values.
 */
export function redactChannelConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const mask = (v: unknown) => (typeof v === "string" && v.length > 0 ? maskValue(v) : v);
  if (type === "slack" || type === "discord") {
    out.webhookUrl = mask(config.webhookUrl);
  } else if (type === "webhook") {
    out.url = mask(config.url);
    if (config.headers) out.headers = "(set)";
  } else if (type === "email") {
    // Recipient + SMTP transport fields are config (not secrets) — show them so
    // the form can prefill. The SMTP password is the only secret: never return
    // it; expose a boolean so the UI can show "configured" without the value.
    out.to = config.to; // recipient address is not a secret — show it
    if (config.host !== undefined) out.host = config.host;
    if (config.port !== undefined) out.port = config.port;
    if (config.from !== undefined) out.from = config.from;
    if (config.user !== undefined) out.user = config.user;
    if (config.secure !== undefined) out.secure = config.secure;
    out.passSet = typeof config.pass === "string" && config.pass.length > 0;
  }
  return out;
}

/** Mask a secret string, keeping a short suffix so it can be recognized. */
function maskValue(v: string): string {
  if (v.length <= 8) return "••••";
  return `••••${v.slice(-6)}`;
}
