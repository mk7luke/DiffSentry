/**
 * Smoke-test the notifications pipeline end-to-end against a temp SQLite DB and
 * a local HTTP server standing in for a Slack incoming webhook.
 * Run: npx tsx scripts/smoke-notifications.ts
 *
 * Asserts:
 *   - admin can create a Slack channel; viewer + author are 403 on writes
 *   - a matching bus event (finding.surfaced, critical) delivers a real Slack
 *     message to the configured webhook (the W1.x acceptance criterion)
 *   - a non-matching event (below the severity floor) does NOT deliver
 *   - the per-channel test-send delivers a real message
 *   - every send is recorded in notification_deliveries
 *   - each write lands an audit_log row (notification.*)
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Static imports on purpose: under tsx, a dynamic import() of a module resolves
// to a DIFFERENT instance than a static import of the same path, which would
// give the test a different `bus` singleton than the engine subscribes to.
// Static imports keep one module graph. DB_PATH is read at openDatabase() call
// time (not import time), so setting it in main() before opening is still fine.
import { openDatabase, closeDatabase } from "../src/storage/db.js";
import { createApiRouter } from "../src/api/router.js";
import { createAuth } from "../src/dashboard/auth.js";
import { startNotifications } from "../src/notify/engine.js";
import { bus } from "../src/realtime/bus.js";
import { getNotificationDeliveries, getAuditLog } from "../src/dashboard/queries.js";

const SESSION_SECRET = "notif-smoke-secret";

function hmac(data: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
}
function sessionValue(login: string, id: number): string {
  const payload = { login, id, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}
function csrfFor(session: string): string {
  return hmac(`csrf:${session}`);
}

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-notif-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
  process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";
  // The fake Slack receiver runs on http://127.0.0.1 — allow both plain-http
  // (scheme) and loopback (egress); otherwise the SSRF guard rejects it.
  process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS = "true";
  process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = "true";

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");
  startNotifications();

  // ── Local "Slack" webhook receiver ─────────────────────────────────
  const received: Array<{ body: any }> = [];
  const receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = { _raw: Buffer.concat(chunks).toString("utf8") };
      }
      received.push({ body });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, r));
  const slackPort = (receiver.address() as { port: number }).port;
  const slackUrl = `http://127.0.0.1:${slackPort}/services/T000/B000/XXX`;

  const learningsDir = path.join(os.tmpdir(), `ds-notif-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  const auth = createAuth({
    clientId: "cid",
    clientSecret: "csecret",
    allowedLogins: ["adminuser", "authoruser", "vieweruser"],
    allowedOrgs: [],
    sessionSecret: SESSION_SECRET,
    baseUrl: "http://localhost/dashboard",
  });

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, auth }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  interface Resp {
    status: number;
    json: any;
  }
  function req(method: string, pathname: string, opts: { session?: string; csrf?: boolean; body?: unknown } = {}): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const cookies: string[] = [];
      if (opts.session) cookies.push(`ds_session=${opts.session}`);
      if (opts.session && opts.csrf) cookies.push(`ds_csrf=${csrfFor(opts.session)}`);
      if (cookies.length) headers["Cookie"] = cookies.join("; ");
      if (opts.session && opts.csrf) headers["X-CSRF-Token"] = csrfFor(opts.session);
      let payload: string | undefined;
      if (opts.body !== undefined) {
        payload = JSON.stringify(opts.body);
        headers["Content-Type"] = "application/json";
      }
      const r = http.request({ hostname: "127.0.0.1", port, path: `/api/v1${pathname}`, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { _raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  };

  const admin = sessionValue("adminuser", 1);
  const author = sessionValue("authoruser", 2);
  const viewer = sessionValue("vieweruser", 3);

  try {
    // ── RBAC: viewer + author forbidden from creating channels ─────────
    const vCreate = await req("POST", "/notifications/channels", {
      session: viewer,
      csrf: true,
      body: { type: "slack", name: "x", config: { webhookUrl: slackUrl } },
    });
    ok("create channel(viewer) → 403", vCreate.status === 403 && vCreate.json.error.code === "forbidden");
    const aCreate = await req("POST", "/notifications/channels", {
      session: author,
      csrf: true,
      body: { type: "slack", name: "x", config: { webhookUrl: slackUrl } },
    });
    ok("create channel(author) → 403 (admin-only)", aCreate.status === 403);

    // ── Admin creates a Slack channel ──────────────────────────────────
    const created = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "slack", name: "#eng-alerts", config: { webhookUrl: slackUrl } },
    });
    ok("create channel(admin) → 201", created.status === 201 && typeof created.json.data.id === "number");
    const channelId: number = created.json.data.id;

    // GET redacts the webhook URL.
    const list = await req("GET", "/notifications", { session: admin });
    const ch = list.json.data.channels.find((c: any) => c.id === channelId);
    ok("GET /notifications redacts webhookUrl", !!ch && typeof ch.config.webhookUrl === "string" && !ch.config.webhookUrl.includes("127.0.0.1"));

    // ── SSRF guard: with the insecure flag OFF, http + private targets 400 ──
    delete process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS;
    delete process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS;
    const httpReject = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "slack", name: "bad", config: { webhookUrl: "http://hooks.slack.com/x" } },
    });
    ok("create channel(plain http) → 400 (https required)", httpReject.status === 400 && httpReject.json.error.code === "bad_request");
    const privReject = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "bad", config: { url: "https://169.254.169.254/latest/meta-data" } },
    });
    ok("create channel(link-local metadata IP) → 400 (SSRF blocked)", privReject.status === 400);
    const mappedReject = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "bad", config: { url: "https://[::ffff:127.0.0.1]/x" } },
    });
    ok("create channel(IPv4-mapped IPv6 loopback) → 400 (SSRF blocked)", mappedReject.status === 400);
    for (const [label, addr] of [["ULA fc00::1", "fc00::1"], ["link-local fe80::1", "fe80::1"]] as const) {
      const r = await req("POST", "/notifications/channels", {
        session: admin,
        csrf: true,
        body: { type: "webhook", name: "bad", config: { url: `https://[${addr}]/x` } },
      });
      ok(`create channel(compressed IPv6 ${label}) → 400 (SSRF blocked)`, r.status === 400);
    }
    const dotReject = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "bad", config: { url: "https://localhost./x" } },
    });
    ok("create channel(trailing-dot localhost.) → 400 (SSRF blocked)", dotReject.status === 400);
    // Insecure SCHEME alone must NOT open private egress: http loopback still blocked.
    process.env.NOTIFY_ALLOW_INSECURE_WEBHOOKS = "true";
    const schemeOnly = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "bad", config: { url: "http://127.0.0.1:1/x" } },
    });
    ok("insecure-scheme on, private-egress off → http loopback still 400", schemeOnly.status === 400);
    process.env.NOTIFY_ALLOW_PRIVATE_WEBHOOKS = "true"; // restore both for the rest

    // ── Webhook custom headers: hop-by-hop / request-controlled are rejected ──
    const badHeader = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "h", config: { url: slackUrl, headers: { Host: "evil" } } },
    });
    ok("create channel(forbidden webhook header) → 400", badHeader.status === 400 && badHeader.json.error.code === "bad_request");

    // ── A non-boolean `enabled` is rejected ────────────────────────────
    const badEnabled = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "slack", name: "e", config: { webhookUrl: slackUrl }, enabled: "false" },
    });
    ok("create channel(non-boolean enabled) → 400", badEnabled.status === 400 && badEnabled.json.error.code === "bad_request");

    // ── Non-http(s) schemes are rejected regardless of egress flags ────
    const badScheme = await req("POST", "/notifications/channels", {
      session: admin,
      csrf: true,
      body: { type: "webhook", name: "s", config: { url: "file:///etc/passwd" } },
    });
    ok("create channel(file:// scheme) → 400", badScheme.status === 400 && badScheme.json.error.code === "bad_request");

    // ── Admin creates a rule: critical finding in acme/web → channel ───
    const rule = await req("POST", "/notifications/rules", {
      session: admin,
      csrf: true,
      body: { name: "crit", scope: "acme/web", condition: { event: "finding", minSeverity: "critical" }, channelId },
    });
    ok("create rule(admin) → 201", rule.status === 201);

    // ── A rule pointing at a non-existent channel is rejected (400) ────
    const badRuleCreate = await req("POST", "/notifications/rules", {
      session: admin,
      csrf: true,
      body: { name: "bad", condition: { event: "finding" }, channelId: 99999 },
    });
    ok("create rule(bad channelId) → 400", badRuleCreate.status === 400 && badRuleCreate.json.error.code === "bad_request");
    const ruleId: number = rule.json.data.id;
    const badRuleUpdate = await req("PUT", `/notifications/rules/${ruleId}`, {
      session: admin,
      csrf: true,
      body: { channelId: 99999 },
    });
    ok("update rule(bad channelId) → 400", badRuleUpdate.status === 400 && badRuleUpdate.json.error.code === "bad_request");

    // ── Malformed route id (partially numeric) is rejected ─────────────
    const badId = await req("PUT", "/notifications/channels/1abc", { session: admin, csrf: true, body: { enabled: false } });
    ok("update channel(id='1abc') → 400", badId.status === 400 && badId.json.error.code === "bad_request");

    // ── A matching event delivers a real Slack message ─────────────────
    received.length = 0;
    bus.publish("finding.surfaced", {
      owner: "acme",
      repo: "web",
      number: 7,
      total: 2,
      critical: 1,
      major: 1,
      minor: 0,
      nit: 0,
      worst: "critical",
      sample: "SQL injection in user lookup",
    });
    await waitFor(() => received.length >= 1);
    ok("matching finding.surfaced → Slack received a message", received.length === 1);
    ok(
      "Slack payload carries the finding title",
      JSON.stringify(received[0].body).includes("acme/web") && JSON.stringify(received[0].body).toLowerCase().includes("critical"),
    );

    // ── A below-floor event does NOT deliver ───────────────────────────
    received.length = 0;
    bus.publish("finding.surfaced", {
      owner: "acme",
      repo: "web",
      number: 8,
      total: 1,
      critical: 0,
      major: 0,
      minor: 1,
      nit: 0,
      worst: "minor",
      sample: "style nit",
    });
    await new Promise((r) => setTimeout(r, 250));
    ok("minor finding (below floor) → no delivery", received.length === 0);

    // ── A different repo does NOT match the acme/web-scoped rule ───────
    received.length = 0;
    bus.publish("finding.surfaced", {
      owner: "other",
      repo: "repo",
      number: 1,
      total: 1,
      critical: 1,
      major: 0,
      minor: 0,
      nit: 0,
      worst: "critical",
      sample: "crit elsewhere",
    });
    await new Promise((r) => setTimeout(r, 250));
    ok("critical finding in unscoped repo → no delivery", received.length === 0);

    // ── Per-channel test-send delivers a real message ──────────────────
    received.length = 0;
    const test = await req("POST", `/notifications/channels/${channelId}/test`, { session: admin, csrf: true, body: {} });
    ok("test-send(admin) → 200 ok", test.status === 200 && test.json.data.ok === true);
    await waitFor(() => received.length >= 1);
    ok("test-send → Slack received a message", received.length === 1 && JSON.stringify(received[0].body).includes("test"));

    // ── test-send requires CSRF + admin ────────────────────────────────
    const testNoCsrf = await req("POST", `/notifications/channels/${channelId}/test`, { session: admin, body: {} });
    ok("test-send(no CSRF) → 403", testNoCsrf.status === 403);

    // ── Deliveries recorded ────────────────────────────────────────────
    const deliveries = getNotificationDeliveries(50);
    ok("notification_deliveries recorded ≥ 2 sends", deliveries.filter((d) => d.status === "ok").length >= 2);
    ok("a delivery is attributed to the rule trigger 'finding'", deliveries.some((d) => d.trigger === "finding"));
    ok("a delivery is attributed to trigger 'test'", deliveries.some((d) => d.trigger === "test"));

    // ── Audit log captured the config writes ───────────────────────────
    const audit = getAuditLog({ limit: 100, offset: 0 });
    const actions = new Set(audit.rows.map((r: any) => r.action));
    ok(
      "audit_log has notification.channel.create + notification.rule.create + notification.channel.test",
      ["notification.channel.create", "notification.rule.create", "notification.channel.test"].every((a) => actions.has(a)),
    );

    console.log("\nall notification smoke checks passed ✓");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => receiver.close(() => r()));
    closeDatabase();
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      // best effort
    }
    try {
      fs.rmSync(learningsDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
