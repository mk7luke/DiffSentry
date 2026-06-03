/**
 * Smoke-test command-center RBAC end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-rbac.ts
 *
 * Forges signed session cookies for an admin / author / viewer login and
 * asserts:
 *   - /me resolves the right role + capabilities (env allowlists)
 *   - requireRole gates: GET /audit is admin-only (403 for author/viewer)
 *   - POST /roles is admin-only AND CSRF-protected (403 without the token)
 *   - a roles-table override beats the env allowlist (precedence)
 *   - every successful write lands an audit_log row
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "rbac-smoke-secret";

function hmac(data: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
}

/** Build a validly-signed ds_session cookie value (mirrors auth.ts). */
function sessionValue(login: string, id: number): string {
  const payload = { login, id, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** The double-submit CSRF token for a session (mirrors createCsrf). */
function csrfFor(session: string): string {
  return hmac(`csrf:${session}`);
}

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-rbac-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  // Role env must be set before the router resolves loadRoleConfigFromEnv().
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
  process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const learningsDir = path.join(os.tmpdir(), `ds-rbac-learnings-${Date.now()}`);
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
  function req(
    method: string,
    pathname: string,
    opts: { session?: string; csrfCookie?: string; csrfHeader?: string; body?: unknown } = {},
  ): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const cookies: string[] = [];
      if (opts.session) cookies.push(`ds_session=${opts.session}`);
      if (opts.csrfCookie) cookies.push(`ds_csrf=${opts.csrfCookie}`);
      if (cookies.length) headers["Cookie"] = cookies.join("; ");
      if (opts.csrfHeader) headers["X-CSRF-Token"] = opts.csrfHeader;
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
  const authorSess = sessionValue("authoruser", 2);
  const viewerSess = sessionValue("vieweruser", 3);

  try {
    // ─── /me resolves role + capabilities from env allowlists ──────────
    const meAdmin = await req("GET", "/me", { session: adminSess });
    ok(
      "me(admin) → role admin + full caps",
      meAdmin.status === 200 &&
        meAdmin.json.data.user.role === "admin" &&
        meAdmin.json.data.user.capabilities.viewAudit === true &&
        meAdmin.json.data.user.capabilities.manageRoles === true,
    );

    const meAuthor = await req("GET", "/me", { session: authorSess });
    ok(
      "me(author) → role author, triggerReview but not viewAudit",
      meAuthor.status === 200 &&
        meAuthor.json.data.user.role === "author" &&
        meAuthor.json.data.user.capabilities.triggerReview === true &&
        meAuthor.json.data.user.capabilities.viewAudit === false &&
        meAuthor.json.data.user.capabilities.manageConfig === false,
    );

    const meViewer = await req("GET", "/me", { session: viewerSess });
    ok(
      "me(viewer) → role viewer, read-only caps",
      meViewer.status === 200 &&
        meViewer.json.data.user.role === "viewer" &&
        meViewer.json.data.user.capabilities.viewDashboard === true &&
        meViewer.json.data.user.capabilities.triggerReview === false,
    );

    // ─── requireRole gate on GET /audit (admin only) ───────────────────
    const auditAdmin = await req("GET", "/audit", { session: adminSess });
    ok("audit(admin) → 200", auditAdmin.status === 200 && Array.isArray(auditAdmin.json.data.rows));

    const auditAuthor = await req("GET", "/audit", { session: authorSess });
    ok("audit(author) → 403 forbidden", auditAuthor.status === 403 && auditAuthor.json.error.code === "forbidden");

    const auditViewer = await req("GET", "/audit", { session: viewerSess });
    ok("audit(viewer) → 403 forbidden", auditViewer.status === 403 && auditViewer.json.error.code === "forbidden");

    const auditAnon = await req("GET", "/audit", {});
    ok("audit(anon) → 401 unauthorized", auditAnon.status === 401 && auditAnon.json.error.code === "unauthorized");

    // ─── POST /roles — role gate fires before CSRF ─────────────────────
    const roleByViewer = await req("POST", "/roles", {
      session: viewerSess,
      csrfCookie: csrfFor(viewerSess),
      csrfHeader: csrfFor(viewerSess),
      body: { login: "someone", role: "author" },
    });
    ok("roles(viewer) → 403 forbidden (role gate)", roleByViewer.status === 403 && roleByViewer.json.error.code === "forbidden");

    // Admin but NO CSRF token → blocked by csrf.verify.
    const roleNoCsrf = await req("POST", "/roles", {
      session: adminSess,
      body: { login: "vieweruser", role: "admin" },
    });
    ok("roles(admin, no CSRF) → 403 CSRF", roleNoCsrf.status === 403);

    // Admin WITH matching CSRF cookie + header → succeeds.
    const roleOk = await req("POST", "/roles", {
      session: adminSess,
      csrfCookie: csrfFor(adminSess),
      csrfHeader: csrfFor(adminSess),
      body: { login: "vieweruser", role: "admin" },
    });
    ok("roles(admin, CSRF) → 200 sets override", roleOk.status === 200 && roleOk.json.data.role === "admin");

    // ─── Precedence: roles-table override beats env (viewer floor) ─────
    const meViewerNow = await req("GET", "/me", { session: viewerSess });
    ok("override precedence → vieweruser is now admin", meViewerNow.status === 200 && meViewerNow.json.data.user.role === "admin");

    // ─── The successful write landed an audit_log row ──────────────────
    const auditAfter = await req("GET", "/audit", { session: adminSess });
    ok(
      "audit trail recorded role.set by adminuser",
      auditAfter.status === 200 &&
        auditAfter.json.data.rows.some(
          (r: any) => r.action === "role.set" && r.actor_login === "adminuser" && r.target_ref === "vieweruser",
        ) &&
        auditAfter.json.data.roles.some((r: any) => r.login === "vieweruser" && r.role === "admin"),
    );

    // ─── Clearing the override falls back to the env/viewer default ────
    const cleared = await req("POST", "/roles", {
      session: adminSess,
      csrfCookie: csrfFor(adminSess),
      csrfHeader: csrfFor(adminSess),
      body: { login: "vieweruser", role: null },
    });
    ok("roles(admin) clear → 200", cleared.status === 200 && cleared.json.data.role === null);
    const meViewerCleared = await req("GET", "/me", { session: viewerSess });
    ok("after clear → vieweruser back to viewer", meViewerCleared.json.data.user.role === "viewer");

    console.log("\nall rbac smoke checks passed ✓");
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
