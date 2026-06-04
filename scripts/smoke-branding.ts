/**
 * Smoke-test instance branding end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-branding.ts
 *
 * Asserts:
 *   - GET /settings/branding returns the built-in defaults initially
 *   - a viewer is forbidden from writing branding (403); CSRF is enforced
 *   - an admin sets name + accent → 200, GET reflects it, audit_log row written
 *   - an invalid accent hex → 400 and nothing is persisted (atomic validation)
 *   - clearing (null) reverts to the env / built-in default
 *   - env defaults (DASHBOARD_INSTANCE_NAME / DASHBOARD_ACCENT_COLOR) are used
 *     when no override is set
 *   - the SSE stream delivers a live settings.updated event
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "branding-smoke-secret";

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
  const tmpDb = path.join(os.tmpdir(), `ds-branding-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
  // Prove the env default is honored before any override is set.
  process.env.DASHBOARD_INSTANCE_NAME = "Acme Review";
  process.env.DASHBOARD_ACCENT_COLOR = "#22cc88";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const learningsDir = path.join(os.tmpdir(), `ds-branding-learnings-${Date.now()}`);
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

  interface Resp {
    status: number;
    json: any;
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
            let json: any = null;
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
      if (payload) r.write(payload);
      r.end();
    });
  }

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  const adminSess = sessionValue("adminuser", 1);
  const viewerSess = sessionValue("vieweruser", 2);
  const B = "/settings/branding";

  try {
    // ── Env defaults used before any override ──────────────────────────
    const initial = await req("GET", B, { session: viewerSess });
    ok(
      "GET branding → env defaults (Acme Review / #22cc88)",
      initial.status === 200 &&
        initial.json.data.instanceName === "Acme Review" &&
        initial.json.data.accentColor === "#22cc88",
    );

    // ── Viewer cannot write ─────────────────────────────────────────────
    const viewerWrite = await req("POST", B, { session: viewerSess, csrf: true, body: { instanceName: "Hax" } });
    ok("POST branding(viewer) → 403", viewerWrite.status === 403 && viewerWrite.json.error.code === "forbidden");

    // ── CSRF enforced for admin ─────────────────────────────────────────
    const noCsrf = await req("POST", B, { session: adminSess, body: { instanceName: "X" } });
    ok("POST branding(admin, no CSRF) → 403", noCsrf.status === 403);

    // ── Admin sets name + accent ────────────────────────────────────────
    const set = await req("POST", B, {
      session: adminSess,
      csrf: true,
      body: { instanceName: "  Globex  Bot ", accentColor: "#FF8800" },
    });
    ok(
      "POST branding(admin) → 200, sanitized + normalized",
      set.status === 200 && set.json.data.instanceName === "Globex Bot" && set.json.data.accentColor === "#ff8800",
    );

    const afterSet = await req("GET", B, { session: viewerSess });
    ok(
      "GET branding → reflects override (overrides env)",
      afterSet.json.data.instanceName === "Globex Bot" && afterSet.json.data.accentColor === "#ff8800",
    );

    // ── Invalid accent → 400, nothing changed ───────────────────────────
    const bad = await req("POST", B, { session: adminSess, csrf: true, body: { accentColor: "not-a-color" } });
    ok("POST branding(bad accent) → 400", bad.status === 400 && bad.json.error.code === "bad_request");
    const afterBad = await req("GET", B, { session: viewerSess });
    ok("bad write left branding untouched", afterBad.json.data.accentColor === "#ff8800");

    // ── Partial validation is atomic: valid name + bad accent → 400, name unchanged
    const partial = await req("POST", B, {
      session: adminSess,
      csrf: true,
      body: { instanceName: "Should Not Stick", accentColor: "zzz" },
    });
    ok("POST branding(valid name + bad accent) → 400", partial.status === 400);
    const afterPartial = await req("GET", B, { session: viewerSess });
    ok("atomic: name not persisted when accent invalid", afterPartial.json.data.instanceName === "Globex Bot");

    // ── Clear (null) → reverts to env default ───────────────────────────
    const cleared = await req("POST", B, {
      session: adminSess,
      csrf: true,
      body: { instanceName: null, accentColor: null },
    });
    ok(
      "POST branding(null) → reverts to env defaults",
      cleared.status === 200 && cleared.json.data.instanceName === "Acme Review" && cleared.json.data.accentColor === "#22cc88",
    );

    // ── Audit log captured the branding writes ──────────────────────────
    const { getAuditLog } = await import("../src/dashboard/queries.js");
    const audit = getAuditLog({ limit: 100, offset: 0 });
    ok(
      "audit_log has settings.branding by adminuser",
      audit.rows.some((r: any) => r.action === "settings.branding" && r.actor_login === "adminuser" && r.target_ref === "global"),
    );

    // ── SSE delivers a live settings.updated event ──────────────────────
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
            if (buf.includes("event: settings.updated")) {
              r.destroy();
              resolve(buf);
            }
          });
          setTimeout(() => {
            void req("POST", B, { session: adminSess, csrf: true, body: { instanceName: "Live Rebrand" } });
          }, 30);
        },
      );
      r.on("error", (err) => {
        if (!buf.includes("event: settings.updated")) reject(err);
      });
      r.end();
      setTimeout(() => reject(new Error("SSE timeout")), 3000);
    });
    ok("SSE stream delivered settings.updated live", sseSeen.includes("event: settings.updated"));

    console.log("\nall branding smoke checks passed ✓");
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
