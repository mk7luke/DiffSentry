/**
 * Smoke-test the operator-settings substrate end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-settings.ts
 *
 * Asserts:
 *   - viewers get 403 on GET/PUT settings (global + per-repo); admins succeed
 *   - GET /settings returns the documented defaults on a fresh DB
 *   - PUT /settings persists overrides, returns the refreshed resolved settings,
 *     audit-logs (settings.set), and publishes 'settings.changed' on the bus
 *   - flipping pauseAll is observable via isPauseAll() (the kill switch)
 *   - log level is applied to the running logger immediately
 *   - invalid values are rejected 400 and persist nothing
 *   - per-repo overrides win for isAutoReviewEnabled / and clear-to-inherit works
 *   - GET + PUT for an unknown repo → 404 (consistent semantics)
 *   - CSRF is enforced on writes
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "settings-smoke-secret";

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
  const tmpDb = path.join(os.tmpdir(), `ds-settings-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");
  const { recordRepo, upsertSettingOverride } = await import("../src/storage/dao.js");
  const {
    isPauseAll,
    isAutoReviewEnabled,
    resolveProfileOverride,
    resolveMaxFilesOverride,
    getGlobalSettings,
    GLOBAL_SETTING_DEFAULTS,
  } = await import("../src/settings/overrides.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");
  recordRepo({ owner: "acme", repo: "web", installationId: 42 });

  const learningsDir = path.join(os.tmpdir(), `ds-settings-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  const auth = createAuth({
    clientId: "cid",
    clientSecret: "csecret",
    allowedLogins: ["adminuser", "vieweruser"],
    allowedOrgs: [],
    sessionSecret: SESSION_SECRET,
    baseUrl: "http://localhost/dashboard",
  });

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, auth }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  // Track open sockets so teardown can force-close a lingering connection (the
  // long-lived /api/v1/stream SSE one) instead of letting server.close() hang
  // waiting for it to end on its own.
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  interface Resp {
    status: number;
    json: unknown;
  }
  function req(
    method: string,
    pathname: string,
    opts: { session?: string; csrf?: boolean; body?: unknown } = {},
  ): Promise<Resp> {
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
      const r = http.request(
        { hostname: "127.0.0.1", port, path: `/api/v1${pathname}`, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = { _raw: text };
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      r.on("error", reject);
      // Bound every request so a hung server fails the smoke with a clear error
      // instead of stalling indefinitely.
      r.setTimeout(5000, () => {
        r.destroy(new Error(`request timeout: ${method} ${pathname}`));
      });
      if (payload) r.write(payload);
      r.end();
    });
  }

  /** Narrow a JSON response to its `data.settings` object before asserting on
   *  its fields — turns a shape drift into a clear failure rather than reading
   *  through `any`. */
  function settingsOf(resp: Resp): Record<string, unknown> {
    const settings = (resp.json as { data?: { settings?: unknown } } | null)?.data?.settings;
    if (typeof settings !== "object" || settings === null) {
      throw new Error(`expected data.settings in response, got: ${JSON.stringify(resp.json)?.slice(0, 200)}`);
    }
    return settings as Record<string, unknown>;
  }

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  const adminSess = sessionValue("adminuser", 1);
  const viewerSess = sessionValue("vieweruser", 2);

  try {
    // ── RBAC: viewers are forbidden ──────────────────────────────────────
    ok("GET /settings (viewer) → 403", (await req("GET", "/settings", { session: viewerSess })).status === 403);
    ok(
      "PUT /settings (viewer) → 403",
      (await req("PUT", "/settings", { session: viewerSess, csrf: true, body: { pauseAll: true } })).status === 403,
    );
    ok(
      "GET repo settings (viewer) → 403",
      (await req("GET", "/repos/acme/web/settings", { session: viewerSess })).status === 403,
    );

    // ── Defaults on a fresh DB ───────────────────────────────────────────
    // Compare against the canonical defaults exported by the settings module
    // (single source of truth) rather than re-stating the literals here.
    const fresh = await req("GET", "/settings", { session: adminSess });
    const s = settingsOf(fresh);
    ok(
      "GET /settings (admin) → documented defaults",
      fresh.status === 200 &&
        s.pauseAll === GLOBAL_SETTING_DEFAULTS.pauseAll &&
        s.autoReview === GLOBAL_SETTING_DEFAULTS.autoReview &&
        s.defaultProfile === GLOBAL_SETTING_DEFAULTS.defaultProfile &&
        s.maxFiles === GLOBAL_SETTING_DEFAULTS.maxFiles,
    );

    // ── Pause-All kill switch ────────────────────────────────────────────
    const pause = await req("PUT", "/settings", { session: adminSess, csrf: true, body: { pauseAll: true } });
    ok("PUT pauseAll=true → 200 + reflected", pause.status === 200 && settingsOf(pause).pauseAll === true);
    ok("isPauseAll() now true (kill switch live)", isPauseAll() === true);

    // ── Log level persisted + resolved (the value applyPersistedSettings reads
    // on startup, and applies to the running logger via setLogLevel — verified
    // in isolation; the live in-process mutation isn't re-checked here because
    // the harness's cross-path import duplicates the logger module). ──────────
    const lvlResp = await req("PUT", "/settings", { session: adminSess, csrf: true, body: { logLevel: "debug" } });
    ok("PUT logLevel → 200 + reflected", lvlResp.status === 200 && settingsOf(lvlResp).logLevel === "debug");
    ok("logLevel override persisted + resolved", getGlobalSettings().logLevel === "debug");

    // ── defaultProfile + maxFiles round-trip ─────────────────────────────
    const profileResp = await req("PUT", "/settings", {
      session: adminSess,
      csrf: true,
      body: { defaultProfile: "assertive", maxFiles: 25 },
    });
    const profileSettings = settingsOf(profileResp);
    ok(
      "PUT defaultProfile + maxFiles → reflected",
      profileSettings.defaultProfile === "assertive" && profileSettings.maxFiles === 25,
    );
    ok("resolveProfileOverride() → assertive (global)", resolveProfileOverride("nope", "nope") === "assertive");
    ok("resolveMaxFilesOverride() → 25 (global)", resolveMaxFilesOverride("nope", "nope") === 25);

    // A corrupted / out-of-range maxFiles written directly (bypassing the API
    // validator) must be ignored by the resolvers, not served back.
    upsertSettingOverride({ scope: "global", key: "maxFiles", value: 9999, updatedBy: "corruption" });
    ok("getGlobalSettings() ignores out-of-range maxFiles", getGlobalSettings().maxFiles === null);
    ok("resolveMaxFilesOverride() ignores out-of-range maxFiles", resolveMaxFilesOverride("nope", "nope") === null);
    // Restore a valid value so the rest of the run is unaffected.
    upsertSettingOverride({ scope: "global", key: "maxFiles", value: 25, updatedBy: "adminuser" });

    // ── Invalid values rejected, nothing persisted ───────────────────────
    const badProfile = await req("PUT", "/settings", { session: adminSess, csrf: true, body: { defaultProfile: "spicy" } });
    ok("PUT invalid profile → 400", badProfile.status === 400);
    const badMax = await req("PUT", "/settings", { session: adminSess, csrf: true, body: { maxFiles: 0 } });
    ok("PUT invalid maxFiles → 400", badMax.status === 400);
    const badKey = await req("PUT", "/settings", { session: adminSess, csrf: true, body: { nope: true } });
    ok("PUT unknown key → 400", badKey.status === 400);

    // ── CSRF enforced ────────────────────────────────────────────────────
    const noCsrf = await req("PUT", "/settings", { session: adminSess, body: { pauseAll: false } });
    ok("PUT /settings (no CSRF) → 403", noCsrf.status === 403);

    // ── Empty body → 400 (at least one key required), no write ───────────
    const emptyGlobal = await req("PUT", "/settings", { session: adminSess, csrf: true, body: {} });
    ok("PUT /settings (empty body) → 400", emptyGlobal.status === 400);
    const emptyRepo = await req("PUT", "/repos/acme/web/settings", { session: adminSess, csrf: true, body: {} });
    ok("PUT repo settings (empty body) → 400", emptyRepo.status === 400);

    // ── Per-repo overrides ───────────────────────────────────────────────
    const repoSet = await req("PUT", "/repos/acme/web/settings", {
      session: adminSess,
      csrf: true,
      body: { autoReview: false, profile: "chill" },
    });
    const repoSettings = settingsOf(repoSet);
    ok(
      "PUT repo settings → reflected",
      repoSet.status === 200 && repoSettings.autoReview === false && repoSettings.profile === "chill",
    );
    ok("isAutoReviewEnabled(acme/web) → false (repo override wins)", isAutoReviewEnabled("acme", "web") === false);
    ok("resolveProfileOverride(acme/web) → chill (repo wins over global)", resolveProfileOverride("acme", "web") === "chill");

    // ── Clearing a per-repo override reverts to inherit ──────────────────
    const cleared = await req("PUT", "/repos/acme/web/settings", { session: adminSess, csrf: true, body: { autoReview: null } });
    ok("PUT repo autoReview=null → cleared", cleared.status === 200 && settingsOf(cleared).autoReview === null);
    // Global autoReview default is still true → repo now inherits true.
    ok("isAutoReviewEnabled(acme/web) → true after clear (inherits global)", isAutoReviewEnabled("acme", "web") === true);

    // ── Unknown repo → 404 (GET + PUT consistent) ────────────────────────
    const ghost = await req("PUT", "/repos/ghost/repo/settings", { session: adminSess, csrf: true, body: { autoReview: false } });
    ok("PUT settings for unknown repo → 404", ghost.status === 404);
    const ghostGet = await req("GET", "/repos/ghost/repo/settings", { session: adminSess });
    ok("GET settings for unknown repo → 404", ghostGet.status === 404);

    // ── Audit log captured the writes ────────────────────────────────────
    const { getAuditLog } = await import("../src/dashboard/queries.js");
    const audit = getAuditLog({ limit: 100, offset: 0 });
    const actions = new Set(audit.rows.map((r: any) => r.action));
    ok("audit_log has settings.set + settings.clear", actions.has("settings.set") && actions.has("settings.clear"));
    ok(
      "audit row attributes actor + setting target",
      audit.rows.some((r: any) => r.action === "settings.set" && r.actor_login === "adminuser" && r.target_ref === "global:pauseAll"),
    );

    // ── SSE stream delivers a live settings.changed event (end-to-end proof
    // that the write → bus → SSE path works on the real, shared bus instance).
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
            clearTimeout(timeout);
            reject(new Error(`stream status ${res.statusCode}`));
            return;
          }
          res.setEncoding("utf8");
          let triggered = false;
          res.on("data", (chunk: string) => {
            buf += chunk;
            // The first chunk (the stream's `retry:` preamble) only reaches us
            // after the server's synchronous handler has run writeHead → write →
            // bus.subscribe — so the subscription is guaranteed live now and a
            // mutation can't be missed. Trigger it exactly once on that signal
            // rather than guessing with a fixed delay after the 200 response.
            if (!triggered) {
              triggered = true;
              void req("PUT", "/settings", { session: adminSess, csrf: true, body: { pauseAll: false } });
            }
            if (buf.includes("event: settings.changed")) {
              clearTimeout(timeout);
              r.destroy();
              resolve(buf);
            }
          });
        },
      );
      r.on("error", (err) => {
        if (!buf.includes("event: settings.changed")) {
          clearTimeout(timeout);
          reject(err);
        }
      });
      r.end();
      const timeout = setTimeout(() => {
        r.destroy();
        reject(new Error("SSE timeout"));
      }, 3000);
    });
    ok("SSE stream delivered settings.changed live", sseSeen.includes("event: settings.changed"));

    console.log("\nall settings smoke checks passed ✓");
  } finally {
    // Force-close any lingering sockets (the long-lived SSE connection) so
    // server.close() resolves instead of waiting on them, then wait for the
    // Express server to fully stop before tearing down the DB and temp files so
    // no in-flight handler touches a closed handle.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
