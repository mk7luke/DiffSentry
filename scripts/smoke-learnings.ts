/**
 * Smoke-test the learnings management API end-to-end against a temp SQLite DB
 * and a temp learnings dir. Run: npx tsx scripts/smoke-learnings.ts
 *
 * Asserts:
 *   - RBAC + CSRF: viewer can't write, author can (only with the CSRF token)
 *   - per-repo + global CRUD round-trips through GET /learnings
 *   - promote moves a repo learning into the global set
 *   - bulk-delete removes across scopes and reports a count
 *   - dedupe surfaces near-identical learnings
 *   - /learnings/test mirrors the engine's path-glob selection
 *   - the engine path (LearningsStore.getRelevantLearnings) consumes globals,
 *     so reviews still apply what the UI writes (format parity)
 *   - owner/repo path-traversal segments are rejected (400)
 *   - every successful write lands an audit_log row
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "learnings-smoke-secret";

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
  const tmpDb = path.join(os.tmpdir(), `ds-learnings-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
  process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");
  const { LearningsStore } = await import("../src/learnings.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const learningsDir = path.join(os.tmpdir(), `ds-learnings-store-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });
  const store = new LearningsStore(learningsDir);

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
    opts: { session?: string; csrf?: string; body?: unknown } = {},
  ): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      const cookies: string[] = [];
      if (opts.session) cookies.push(`ds_session=${opts.session}`);
      if (opts.csrf) cookies.push(`ds_csrf=${opts.csrf}`);
      if (cookies.length) headers["Cookie"] = cookies.join("; ");
      if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
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
    // ─── Reads require auth (viewer floor) ─────────────────────────────
    const listAnon = await req("GET", "/learnings", {});
    ok("list(anon) → 401 unauthorized", listAnon.status === 401 && listAnon.json.error.code === "unauthorized");
    const testAnon = await req("POST", "/learnings/test", { body: { path: "src/index.ts" } });
    ok("test(anon) → 401 unauthorized", testAnon.status === 401 && testAnon.json.error.code === "unauthorized");

    // ─── RBAC + CSRF on create ─────────────────────────────────────────
    const byViewer = await req("POST", "/repos/acme/widget/learnings", {
      session: viewerSess,
      csrf: csrfFor(viewerSess),
      body: { content: "viewers can't write" },
    });
    ok("create(viewer) → 403 forbidden", byViewer.status === 403 && byViewer.json.error.code === "forbidden");

    const noCsrf = await req("POST", "/repos/acme/widget/learnings", {
      session: authorSess,
      body: { content: "no csrf" },
    });
    ok("create(author, no CSRF) → 403", noCsrf.status === 403);

    const created = await req("POST", "/repos/acme/widget/learnings", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "Prefer async/await over promise chains.", path: "src/**/*.ts" },
    });
    ok(
      "create(author, CSRF) → 201",
      created.status === 201 && typeof created.json.data.id === "string" && created.json.data.path === "src/**/*.ts",
    );
    const repoId = created.json.data.id as string;

    // ─── Path traversal rejected ───────────────────────────────────────
    const traversal = await req("POST", "/repos/../etc/learnings", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "nope" },
    });
    ok("create with '..' segment → 400 bad_request", traversal.status === 400);

    // ─── Empty content rejected ────────────────────────────────────────
    const empty = await req("POST", "/repos/acme/widget/learnings", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "   " },
    });
    ok("create blank content → 400 bad_request", empty.status === 400);

    // ─── Global create ─────────────────────────────────────────────────
    const global = await req("POST", "/learnings/global", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "Never log secrets or tokens." },
    });
    ok("create global → 201", global.status === 201 && typeof global.json.data.id === "string");
    const globalId = global.json.data.id as string;

    // ─── List reflects both ────────────────────────────────────────────
    const list1 = await req("GET", "/learnings", { session: viewerSess });
    ok(
      "list shows repo + global (viewer can read)",
      list1.status === 200 &&
        list1.json.data.global.some((l: any) => l.id === globalId) &&
        list1.json.data.repos.some((r: any) => r.owner === "acme" && r.repo === "widget" && r.learnings.length === 1),
    );

    // ─── Engine parity: globals reach getRelevantLearnings ─────────────
    const relevant = await store.getRelevantLearnings("acme/widget", ["src/index.ts"]);
    ok(
      "engine consumes global + path-matched repo learning",
      relevant.some((l) => l.id === globalId) && relevant.some((l) => l.id === repoId),
    );
    const relevantOther = await store.getRelevantLearnings("acme/widget", ["README.md"]);
    ok(
      "path-scoped repo learning filtered out for non-matching file; global still applies",
      relevantOther.some((l) => l.id === globalId) && !relevantOther.some((l) => l.id === repoId),
    );

    // ─── /learnings/test mirrors selection ─────────────────────────────
    const testMatch = await req("POST", "/learnings/test", {
      session: viewerSess,
      body: { owner: "acme", repo: "widget", path: "src/app.ts" },
    });
    ok(
      "test matching path → repo + global",
      testMatch.status === 200 &&
        testMatch.json.data.matched.some((l: any) => l.id === repoId) &&
        testMatch.json.data.matched.some((l: any) => l.id === globalId),
    );
    ok(
      "test matches are scope-tagged with the learning's own owner/repo",
      testMatch.json.data.matched.find((l: any) => l.id === repoId)?.scope === "repo" &&
        testMatch.json.data.matched.find((l: any) => l.id === repoId)?.owner === "acme" &&
        testMatch.json.data.matched.find((l: any) => l.id === repoId)?.repo === "widget" &&
        testMatch.json.data.matched.find((l: any) => l.id === globalId)?.scope === "global",
    );
    const testNoMatch = await req("POST", "/learnings/test", {
      session: viewerSess,
      body: { owner: "acme", repo: "widget", path: "docs/readme.md" },
    });
    ok(
      "test non-matching path → global only",
      testNoMatch.json.data.matched.some((l: any) => l.id === globalId) &&
        !testNoMatch.json.data.matched.some((l: any) => l.id === repoId),
    );

    // ─── Update ────────────────────────────────────────────────────────
    const updated = await req("PUT", `/repos/acme/widget/learnings/${repoId}`, {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "Prefer async/await; avoid nested .then().", path: null },
    });
    ok(
      "update clears path + edits content",
      updated.status === 200 && updated.json.data.path === undefined && updated.json.data.content.includes("nested"),
    );

    const emptyUpdate = await req("PUT", `/repos/acme/widget/learnings/${repoId}`, {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: {},
    });
    ok("empty partial update → 400 (no-op rejected)", emptyUpdate.status === 400 && emptyUpdate.json.error.code === "bad_request");

    // ─── Promote to global ─────────────────────────────────────────────
    const promoted = await req("POST", `/repos/acme/widget/learnings/${repoId}/promote`, {
      session: authorSess,
      csrf: csrfFor(authorSess),
    });
    ok("promote → 200 new global id", promoted.status === 200 && typeof promoted.json.data.id === "string");
    const promotedId = promoted.json.data.id as string;
    const afterPromote = await req("GET", "/learnings", { session: authorSess });
    ok(
      "after promote: gone from repo, present in global",
      afterPromote.json.data.global.some((l: any) => l.id === promotedId) &&
        !afterPromote.json.data.repos.some((r: any) => r.owner === "acme" && r.repo === "widget"),
    );

    // ─── Dedupe suggestions ────────────────────────────────────────────
    await req("POST", "/learnings/global", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { content: "Never log secrets or tokens" },
    });
    const dupList = await req("GET", "/learnings", { session: authorSess });
    ok(
      "dedupe surfaces the near-identical 'Never log secrets' pair",
      dupList.json.data.duplicates.some(
        (g: any) => g.members.length >= 2 && g.members.every((m: any) => /never log secrets/i.test(m.content)),
      ),
    );

    // ─── Bulk delete ───────────────────────────────────────────────────
    const badBulk = await req("POST", "/learnings/bulk-delete", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { items: [{ scope: "global" }] }, // missing id
    });
    ok("bulk-delete with malformed item → 400", badBulk.status === 400 && badBulk.json.error.code === "bad_request");

    const allGlobals = (await req("GET", "/learnings", { session: authorSess })).json.data.global;
    const bulk = await req("POST", "/learnings/bulk-delete", {
      session: authorSess,
      csrf: csrfFor(authorSess),
      body: { items: allGlobals.map((l: any) => ({ scope: "global", id: l.id })) },
    });
    ok("bulk-delete removes all globals", bulk.status === 200 && bulk.json.data.deleted === allGlobals.length);
    const emptyGlobals = (await req("GET", "/learnings", { session: authorSess })).json.data.global;
    ok("globals empty after bulk-delete", emptyGlobals.length === 0);

    // ─── Audit trail recorded the writes ───────────────────────────────
    const audit = await req("GET", "/audit", { session: adminSess });
    ok(
      "audit trail recorded learning.* actions by authoruser",
      audit.status === 200 &&
        audit.json.data.rows.some((r: any) => r.action === "learning.create" && r.actor_login === "authoruser") &&
        audit.json.data.rows.some((r: any) => r.action === "learning.promote") &&
        audit.json.data.rows.some((r: any) => r.action === "learning.bulk_delete"),
    );

    // ─── 404 on missing ids ────────────────────────────────────────────
    const missing = await req("DELETE", "/repos/acme/widget/learnings/does-not-exist", {
      session: authorSess,
      csrf: csrfFor(authorSess),
    });
    ok("delete unknown id → 404", missing.status === 404 && missing.json.error.code === "not_found");

    console.log("\nall learnings smoke checks passed ✓");
  } finally {
    server.close();
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
