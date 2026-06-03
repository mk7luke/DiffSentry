/**
 * Smoke-test webhook delivery capture + inspection + replay end-to-end against a
 * temp SQLite DB. Run: npx tsx scripts/smoke-webhooks.ts
 *
 * Asserts:
 *   - recordWebhookDelivery persists rows; getWebhookDeliveries/Delivery read them
 *   - the deliveries endpoints are admin-only (viewer + author → 403)
 *   - admin GET /webhooks lists + filters by event; GET /webhooks/:id returns the
 *     full stored payload
 *   - admin POST /webhooks/:id/replay → 202, re-dispatches the stored payload
 *     through the engine (fake reviewer.handlePullRequest called), records a NEW
 *     delivery row flagged replayed_from, writes a webhook.replay audit row, and
 *     publishes webhook.replayed on the bus / over SSE
 *   - replay without the CSRF token → 403
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "webhooks-smoke-secret";

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

interface Call {
  method: string;
  args: unknown[];
}

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-webhooks-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
  process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");
  const { recordWebhookDelivery } = await import("../src/storage/dao.js");
  const { getWebhookDeliveries, getWebhookDelivery, getAuditLog } = await import("../src/dashboard/queries.js");
  const { dispatchWebhookEvent, extractWebhookMeta } = await import("../src/webhook/dispatch.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  // ── Capture: persist a couple of deliveries directly (as the /webhook
  //    handler does) and read them back via the query layer. ───────────────
  const prPayload = {
    action: "opened",
    pull_request: { number: 7 },
    repository: { name: "web", owner: { login: "acme" } },
    installation: { id: 42 },
  };
  const prDeliveryId = recordWebhookDelivery({
    event: "pull_request",
    action: "opened",
    owner: "acme",
    repo: "web",
    number: 7,
    deliveryId: "gh-delivery-001",
    signatureOk: true,
    payload: prPayload,
  });
  recordWebhookDelivery({
    event: "issues",
    action: "opened",
    owner: "acme",
    repo: "web",
    number: 9,
    deliveryId: "gh-delivery-002",
    signatureOk: false, // a rejected delivery is still captured
    payload: { action: "opened", issue: { number: 9 }, repository: { name: "web", owner: { login: "acme" } } },
  });
  ok("recordWebhookDelivery returned a rowid", typeof prDeliveryId === "number" && prDeliveryId! > 0);

  const listed = getWebhookDeliveries({ limit: 50, offset: 0 });
  ok("getWebhookDeliveries lists both", listed.total === 2 && listed.rows.length === 2);
  ok(
    "list rows carry metadata + payload_bytes but not payload_json",
    listed.rows.every((r) => typeof (r as any).payload_bytes === "number" && !("payload_json" in r)),
  );
  const filteredByEvent = getWebhookDeliveries({ event: "pull_request" });
  ok("getWebhookDeliveries filters by event", filteredByEvent.total === 1 && filteredByEvent.rows[0].event === "pull_request");

  const detail = getWebhookDelivery(prDeliveryId!);
  ok("getWebhookDelivery returns the full payload", !!detail && !!detail.payload_json && detail.payload_json!.includes("\"number\":7"));

  // ── Fake reviewer + replay closure (mirrors server.ts wiring) ────────────
  const calls: Call[] = [];
  const fakeReviewer = {
    handlePullRequest: (...args: unknown[]) => {
      calls.push({ method: "handlePullRequest", args });
      return Promise.resolve();
    },
    autoResolveOnPush: () => Promise.resolve(),
    handlePRClose: () => {},
    handleIssueOpened: (...args: unknown[]) => {
      calls.push({ method: "handleIssueOpened", args });
      return Promise.resolve();
    },
    handleComment: () => Promise.resolve(),
    handleIssueComment: () => Promise.resolve(),
    getInstallationOctokit: () => Promise.reject(new Error("not used in smoke")),
  };
  const replayWebhook = async ({
    event,
    payload,
    replayedFrom,
  }: {
    event: string;
    payload: unknown;
    replayedFrom: number;
  }) => {
    const meta = extractWebhookMeta(payload);
    const newDeliveryId = recordWebhookDelivery({
      event,
      action: meta.action,
      owner: meta.owner,
      repo: meta.repo,
      number: meta.number,
      signatureOk: true,
      payload,
      replayedFrom,
    });
    const { status } = await dispatchWebhookEvent({ reviewer: fakeReviewer as any, botName: "diffsentry" }, event, payload);
    return { newDeliveryId, status };
  };

  const learningsDir = path.join(os.tmpdir(), `ds-webhooks-learnings-${Date.now()}`);
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
  app.use("/api/v1", createApiRouter({ learningsDir, auth, replayWebhook }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  interface Resp {
    status: number;
    json: any;
  }
  function req(method: string, pathname: string, opts: { session?: string; csrf?: boolean } = {}): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const cookies: string[] = [];
      if (opts.session) cookies.push(`ds_session=${opts.session}`);
      if (opts.session && opts.csrf) cookies.push(`ds_csrf=${csrfFor(opts.session)}`);
      if (cookies.length) headers["Cookie"] = cookies.join("; ");
      if (opts.session && opts.csrf) headers["X-CSRF-Token"] = csrfFor(opts.session);
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
      r.end();
    });
  }

  const adminSess = sessionValue("adminuser", 1);
  const authorSess = sessionValue("authoruser", 2);
  const viewerSess = sessionValue("vieweruser", 3);

  try {
    // ── Admin-only reads ───────────────────────────────────────────────
    const viewerList = await req("GET", "/webhooks", { session: viewerSess });
    ok("GET /webhooks (viewer) → 403", viewerList.status === 403 && viewerList.json.error.code === "forbidden");
    const authorList = await req("GET", "/webhooks", { session: authorSess });
    ok("GET /webhooks (author) → 403", authorList.status === 403);

    const adminList = await req("GET", "/webhooks", { session: adminSess });
    ok(
      "GET /webhooks (admin) → list + filters",
      adminList.status === 200 &&
        adminList.json.data.total === 2 &&
        adminList.json.data.events.includes("pull_request") &&
        adminList.json.data.repos.includes("acme/web"),
    );

    const adminFiltered = await req("GET", "/webhooks?event=pull_request", { session: adminSess });
    ok(
      "GET /webhooks?event= filters",
      adminFiltered.status === 200 &&
        adminFiltered.json.data.rows.length === 1 &&
        adminFiltered.json.data.rows[0].event === "pull_request",
    );

    const adminDetail = await req("GET", `/webhooks/${prDeliveryId}`, { session: adminSess });
    ok(
      "GET /webhooks/:id (admin) → full payload",
      adminDetail.status === 200 && typeof adminDetail.json.data.payload_json === "string" && adminDetail.json.data.delivery_id === "gh-delivery-001",
    );

    const missingDetail = await req("GET", "/webhooks/99999", { session: adminSess });
    ok("GET /webhooks/:id (missing) → 404", missingDetail.status === 404 && missingDetail.json.error.code === "not_found");

    // ── Strict id parsing: a non-numeric segment is rejected, not truncated ──
    const junkId = await req("GET", `/webhooks/${prDeliveryId}abc`, { session: adminSess });
    ok("GET /webhooks/<id>abc → 400 (not delivery <id>)", junkId.status === 400 && junkId.json.error.code === "bad_request");

    // ── A rejected (bad-signature) delivery cannot be replayed ──────────
    const rejected = getWebhookDeliveries({ event: "issues" }).rows[0];
    const rejectedReplay = await req("POST", `/webhooks/${rejected.id}/replay`, { session: adminSess, csrf: true });
    ok(
      "replay (rejected delivery) → 400 bad_request",
      rejectedReplay.status === 400 &&
        rejectedReplay.json.error.code === "bad_request" &&
        /cannot be replayed/i.test(rejectedReplay.json.error.message),
    );

    // ── Replay is admin + CSRF gated ───────────────────────────────────
    const viewerReplay = await req("POST", `/webhooks/${prDeliveryId}/replay`, { session: viewerSess, csrf: true });
    ok("replay (viewer) → 403", viewerReplay.status === 403);
    const noCsrfReplay = await req("POST", `/webhooks/${prDeliveryId}/replay`, { session: adminSess });
    ok("replay (admin, no CSRF) → 403", noCsrfReplay.status === 403);

    // ── Admin replay re-dispatches + flags the new row ─────────────────
    const replay = await req("POST", `/webhooks/${prDeliveryId}/replay`, { session: adminSess, csrf: true });
    ok(
      "replay (admin) → 202 replayed + new delivery id",
      replay.status === 202 && replay.json.data.result === "replayed" && typeof replay.json.data.newDeliveryId === "number",
    );

    // The fire-and-forget handlePullRequest runs on next tick.
    await new Promise((r) => setTimeout(r, 20));
    const dispatched = calls.find((c) => c.method === "handlePullRequest");
    ok(
      "replay → reviewer.handlePullRequest(42, acme, web, 7, full)",
      !!dispatched &&
        dispatched.args[0] === 42 &&
        dispatched.args[1] === "acme" &&
        dispatched.args[2] === "web" &&
        dispatched.args[3] === 7 &&
        dispatched.args[4] === "full",
    );

    const newId = replay.json.data.newDeliveryId as number;
    const replayed = getWebhookDelivery(newId);
    ok("replay recorded a new row flagged replayed_from", !!replayed && replayed.replayed_from === prDeliveryId);
    ok("replay row is signature_ok (operator-sourced)", !!replayed && replayed.signature_ok === 1);

    const total = getWebhookDeliveries({ limit: 50 }).total;
    ok("delivery count grew by the replay row", total === 3);

    // ── Replay is in the audit log, marked as a replay ─────────────────
    const audit = getAuditLog({ limit: 50, offset: 0 });
    const replayAudit = audit.rows.find((r: any) => r.action === "webhook.replay");
    ok(
      "audit_log has webhook.replay attributed to admin + target",
      !!replayAudit && replayAudit.actor_login === "adminuser" && replayAudit.target_ref === String(prDeliveryId) && replayAudit.result === "ok",
    );

    // ── SSE delivers webhook.replayed live ─────────────────────────────
    const sseSeen = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/v1/stream",
          method: "GET",
          headers: { Accept: "text/event-stream", Cookie: `ds_session=${adminSess}` },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`stream status ${res.statusCode}`));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("event: webhook.replayed")) {
              r.destroy();
              resolve(buf);
            }
          });
          setTimeout(() => {
            void req("POST", `/webhooks/${prDeliveryId}/replay`, { session: adminSess, csrf: true });
          }, 30);
        },
      );
      r.on("error", (err) => {
        if (!buf.includes("event: webhook.replayed")) reject(err);
      });
      r.end();
      setTimeout(() => reject(new Error("SSE timeout")), 3000);
    });
    ok("SSE stream delivered webhook.replayed live", sseSeen.includes("event: webhook.replayed"));

    console.log("\nall webhook smoke checks passed ✓");
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      // best effort
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
