/**
 * Smoke-test the platform API: bearer-token auth, scopes, revocation, the
 * OpenAPI spec, and the docs page — end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-tokens.ts
 *
 * Asserts the acceptance criteria:
 *   - an admin cookie session can create a token (plaintext shown once)
 *   - a curl with the bearer token can read /api/v1/repos
 *   - a read-only token is rejected (403) when it tries a write (over-scope)
 *   - a token can never reach admin endpoints (/audit, POST /tokens)
 *   - a revoked token is rejected (401)
 *   - an unknown token is rejected (401)
 *   - /openapi.json and /docs are public and well-formed
 *   - token.create lands an audit_log row and last_used_at is tracked
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "tokens-smoke-secret";

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
  const tmpDb = path.join(os.tmpdir(), `ds-tokens-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run(
    "mk7luke",
    "diffsentry-sandbox",
    1,
    now,
    now,
  );

  const learningsDir = path.join(os.tmpdir(), `ds-tokens-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  const auth = createAuth({
    clientId: "cid",
    clientSecret: "csecret",
    allowedLogins: ["adminuser"],
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
    text: string;
    contentType: string;
  }
  function req(
    method: string,
    pathname: string,
    opts: { session?: string; csrf?: string; bearer?: string; body?: unknown } = {},
  ): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const cookies: string[] = [];
      if (opts.session) cookies.push(`ds_session=${opts.session}`);
      if (opts.csrf) {
        cookies.push(`ds_csrf=${opts.csrf}`);
        headers["X-CSRF-Token"] = opts.csrf;
      }
      if (cookies.length) headers["Cookie"] = cookies.join("; ");
      if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
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
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text, contentType: res.headers["content-type"] ?? "" });
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

  const adminSess = sessionValue("adminuser", 1);
  const adminCsrf = csrfFor(adminSess);

  try {
    // ─── Public surface (no auth) ──────────────────────────────────────
    const spec = await req("GET", "/openapi.json");
    ok(
      "openapi.json → public 200, OpenAPI 3 doc",
      spec.status === 200 && spec.json?.openapi === "3.0.3" && !!spec.json?.paths?.["/repos"],
    );

    const docs = await req("GET", "/docs");
    ok(
      "docs → public 200 HTML",
      docs.status === 200 && docs.contentType.includes("text/html") && docs.text.includes("DiffSentry API"),
    );

    // ─── Anonymous (no token, no session) is rejected ──────────────────
    const anon = await req("GET", "/repos");
    ok("repos(anon) → 401", anon.status === 401 && anon.json.error.code === "unauthorized");

    // ─── Admin cookie creates a read-only token (secret shown once) ────
    const created = await req("POST", "/tokens", {
      session: adminSess,
      csrf: adminCsrf,
      body: { name: "ci-readonly", scopes: ["read"] },
    });
    ok(
      "create(admin) → 201 with one-time secret",
      created.status === 201 &&
        typeof created.json.data.token === "string" &&
        created.json.data.token.startsWith("dsk_") &&
        created.json.data.scopes.join(",") === "read",
    );
    const readToken: string = created.json.data.token;
    const readTokenId: number = created.json.data.id;

    // ─── ACCEPTANCE: a bearer token can read /api/v1/repos ─────────────
    const reposByToken = await req("GET", "/repos", { bearer: readToken });
    ok(
      "repos(bearer read token) → 200 with data",
      reposByToken.status === 200 && reposByToken.json.data.repos.some((r: any) => r.repo === "diffsentry-sandbox"),
    );

    // /me resolves the token as a read-only viewer principal.
    const meToken = await req("GET", "/me", { bearer: readToken });
    ok(
      "me(read token) → viewer principal",
      meToken.status === 200 &&
        meToken.json.data.user.role === "viewer" &&
        meToken.json.data.user.login === "token:ci-readonly",
    );

    // ─── A token can never reach admin endpoints ───────────────────────
    const auditByToken = await req("GET", "/audit", { bearer: readToken });
    ok("audit(token) → 403 forbidden", auditByToken.status === 403 && auditByToken.json.error.code === "forbidden");

    const createByToken = await req("POST", "/tokens", { bearer: readToken, body: { name: "x", scopes: ["read"] } });
    ok("create(token) → 403 forbidden", createByToken.status === 403 && createByToken.json.error.code === "forbidden");

    // ─── ACCEPTANCE: over-scope write is rejected ──────────────────────
    // A read-only token attempting any mutating request is blocked by the
    // scope gate before it can reach an action handler.
    const overScope = await req("POST", "/repos/mk7luke/diffsentry-sandbox/prs/1/review", { bearer: readToken });
    ok(
      "review(read-only token) → 403 lacks 'review' scope",
      overScope.status === 403 && /review/.test(overScope.json.error.message),
    );

    // ─── A review-scoped token implies read and resolves as author ─────
    const createdRev = await req("POST", "/tokens", {
      session: adminSess,
      csrf: adminCsrf,
      body: { name: "ci-review", scopes: ["review"] },
    });
    ok(
      "create review token → scopes include read (review implies read)",
      createdRev.status === 201 && createdRev.json.data.scopes.includes("read") && createdRev.json.data.scopes.includes("review"),
    );
    const reviewToken: string = createdRev.json.data.token;
    const meReview = await req("GET", "/me", { bearer: reviewToken });
    ok("me(review token) → author principal", meReview.status === 200 && meReview.json.data.user.role === "author");
    const reposByReview = await req("GET", "/repos", { bearer: reviewToken });
    ok("repos(review token) → 200 (read implied)", reposByReview.status === 200);

    // ─── Unknown token → 401 ───────────────────────────────────────────
    const badToken = await req("GET", "/repos", { bearer: "dsk_not-a-real-token" });
    ok("repos(unknown token) → 401", badToken.status === 401 && badToken.json.error.code === "unauthorized");

    // ─── ACCEPTANCE: revoked token → 401 ───────────────────────────────
    const revoke = await req("DELETE", `/tokens/${readTokenId}`, { session: adminSess, csrf: adminCsrf });
    ok("revoke(admin) → 200 revoked:true", revoke.status === 200 && revoke.json.data.revoked === true);

    const afterRevoke = await req("GET", "/repos", { bearer: readToken });
    ok(
      "repos(revoked token) → 401 invalid/revoked",
      afterRevoke.status === 401 && /revoked/i.test(afterRevoke.json.error.message),
    );

    // ─── last_used_at tracking + audit trail ───────────────────────────
    const list = await req("GET", "/tokens", { session: adminSess });
    const reviewMeta = list.json.data.tokens.find((t: any) => t.name === "ci-review");
    ok("list(admin) → tokens, never the hash", list.status === 200 && !("token_hash" in (reviewMeta ?? {})));
    ok("last_used_at tracked after bearer use", !!reviewMeta && reviewMeta.last_used_at != null);
    ok(
      "revoked token shows revoked_at in list",
      list.json.data.tokens.some((t: any) => t.id === readTokenId && t.revoked_at != null),
    );

    const audit = await req("GET", "/audit", { session: adminSess });
    ok(
      "audit trail recorded token.create + token.revoke",
      audit.status === 200 &&
        audit.json.data.rows.some((r: any) => r.action === "token.create" && r.actor_login === "adminuser") &&
        audit.json.data.rows.some((r: any) => r.action === "token.revoke"),
    );

    console.log("\nall token smoke checks passed ✓");
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
