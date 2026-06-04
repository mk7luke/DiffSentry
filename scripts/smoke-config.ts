/**
 * Smoke-test the repo-config endpoints end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-config.ts
 *
 * A fake installation Octokit records the GitHub calls the PUT handler makes
 * (commit / open-PR) and serves the "current" .diffsentry.yaml for reads.
 * Asserts:
 *   - GET returns the YAML, parsed + effective config, and the JSON schema
 *   - viewers + authors are forbidden from PUT; admins succeed
 *   - invalid YAML and schema-invalid configs are blocked (400) before any commit
 *   - a valid direct commit calls createOrUpdateFileContents on the default branch,
 *     writes a config.update audit row, publishes config.updated on the bus, and
 *     invalidates the read cache (next GET sees the new YAML)
 *   - "pr" mode creates a branch + opens a PR instead of committing to default
 *   - CSRF is enforced; a repo with no installation → 404
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "config-smoke-secret";

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
  // Snapshot the env we mutate so a harness that imports this script gets its
  // process.env back (restored in the finally block).
  const prevEnv = {
    DB_PATH: process.env.DB_PATH,
    DASHBOARD_ADMIN_LOGINS: process.env.DASHBOARD_ADMIN_LOGINS,
    DASHBOARD_AUTHOR_LOGINS: process.env.DASHBOARD_AUTHOR_LOGINS,
  };

  // Resources are declared out here and created inside the try, so the finally
  // can clean up whatever exists even if a setup step (env mutation, dynamic
  // import, openDatabase, recordRepo, app.listen, …) throws — and process.env
  // is restored no matter where we fail.
  let tmpDb: string | undefined;
  let learningsDir: string | undefined;
  let server: import("node:http").Server | undefined;
  let sse: import("node:http").ClientRequest | undefined;
  let closeDatabase: (() => void) | undefined;

  try {
    tmpDb = path.join(os.tmpdir(), `ds-config-smoke-${Date.now()}.db`);
    process.env.DB_PATH = tmpDb;
    process.env.DASHBOARD_ADMIN_LOGINS = "adminuser";
    process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";

    const dbModule = await import("../src/storage/db.js");
    const { createApiRouter } = await import("../src/api/router.js");
    const { createAuth } = await import("../src/dashboard/auth.js");
    const { recordRepo } = await import("../src/storage/dao.js");
    const { getAuditLog } = await import("../src/dashboard/queries.js");
    closeDatabase = dbModule.closeDatabase;

    const db = dbModule.openDatabase();
    if (!db) throw new Error("failed to open temp db");
    recordRepo({ owner: "acme", repo: "web", installationId: 42 });
    recordRepo({ owner: "acme", repo: "transient", installationId: 42 });

    learningsDir = path.join(os.tmpdir(), `ds-config-learnings-${Date.now()}`);
    fs.mkdirSync(learningsDir, { recursive: true });

    // ── Fake installation Octokit: holds the current file + records writes. ──
    const calls: Call[] = [];
    let fileContent: string | null = "reviews:\n  profile: chill\n";
    let fileSha = "sha-0";
    let transientFail = false;
    let failCreateRefOnce = false;
    let failPullsCreateOnce = false;
    const octokit = {
      repos: {
        get: (args: unknown) => {
          calls.push({ method: "repos.get", args: [args] });
          return Promise.resolve({ data: { default_branch: "main" } });
        },
        getContent: (args: unknown) => {
          calls.push({ method: "repos.getContent", args: [args] });
          if (transientFail) {
            // One-shot transient failure (e.g. rate limit / 5xx) — must NOT be cached.
            transientFail = false;
            return Promise.reject(Object.assign(new Error("rate limited"), { status: 500 }));
          }
          if (fileContent === null) return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
          return Promise.resolve({
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(fileContent).toString("base64"),
              sha: fileSha,
            },
          });
        },
        createOrUpdateFileContents: (args: any) => {
          calls.push({ method: "repos.createOrUpdateFileContents", args: [args] });
          // A commit to the default branch mutates what reads return next.
          if (args.branch === "main") {
            fileContent = Buffer.from(args.content, "base64").toString("utf-8");
            fileSha = `sha-${calls.length}`;
          }
          return Promise.resolve({ data: { commit: { sha: "commit-abc" } } });
        },
      },
      git: {
        getRef: (args: unknown) => {
          calls.push({ method: "git.getRef", args: [args] });
          return Promise.resolve({ data: { object: { sha: "base-sha" } } });
        },
        createRef: (args: unknown) => {
          calls.push({ method: "git.createRef", args: [args] });
          if (failCreateRefOnce) {
            // Simulate a one-shot ref-already-exists collision; commitViaPr should
            // regenerate the branch name and retry.
            failCreateRefOnce = false;
            return Promise.reject(Object.assign(new Error("Reference already exists"), { status: 422 }));
          }
          return Promise.resolve({ data: {} });
        },
        deleteRef: (args: unknown) => {
          calls.push({ method: "git.deleteRef", args: [args] });
          return Promise.resolve({ data: {} });
        },
      },
      pulls: {
        create: (args: unknown) => {
          calls.push({ method: "pulls.create", args: [args] });
          if (failPullsCreateOnce) {
            // Simulate a failure after the branch was created; commitViaPr should
            // best-effort delete the orphaned branch and rethrow.
            failPullsCreateOnce = false;
            return Promise.reject(Object.assign(new Error("validation failed"), { status: 422 }));
          }
          return Promise.resolve({ data: { number: 99, html_url: "https://github.com/acme/web/pull/99" } });
        },
      },
    };

    const auth = createAuth({
      clientId: "cid",
      clientSecret: "csecret",
      allowedLogins: ["adminuser", "authoruser", "vieweruser"],
      allowedOrgs: [],
      sessionSecret: SESSION_SECRET,
      baseUrl: "http://localhost/dashboard",
    });

    const app = express();
    app.use(
      "/api/v1",
      createApiRouter({
        learningsDir,
        auth,
        getInstallationOctokit: () => Promise.resolve(octokit as any),
      }),
    );
    server = app.listen(0);
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

    const adminSess = sessionValue("adminuser", 1);
    const authorSess = sessionValue("authoruser", 2);
    const viewerSess = sessionValue("vieweruser", 3);
    const CFG = "/repos/acme/web/config";

    // Capture bus events through the real SSE stream (proves the action → bus →
    // SSE path on the shared bus instance the handlers use).
    const busEvents: Array<{ topic: string; payload: any }> = [];
    sse = http.request(
      { hostname: "127.0.0.1", port, path: "/api/v1/stream", method: "GET", headers: { Accept: "text/event-stream", Cookie: `ds_session=${adminSess}` } },
      (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const topic = /^event: (.+)$/m.exec(frame)?.[1];
            const dataLine = /^data: (.+)$/m.exec(frame)?.[1];
            if (topic && dataLine) {
              try {
                busEvents.push({ topic, payload: JSON.parse(dataLine).payload });
              } catch {
                // ignore non-JSON frames (retry:, heartbeats)
              }
            }
          }
        });
      },
    );
    sse.on("error", () => {});
    sse.end();
    // Let the SSE connection establish before triggering actions.
    await new Promise((r) => setTimeout(r, 80));

    // Poll busEvents for a matching frame (SSE delivery is async).
    async function waitForEvent(match: (e: { topic: string; payload: any }) => boolean): Promise<boolean> {
      for (let i = 0; i < 40; i++) {
        if (busEvents.some(match)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }

    // ── GET returns YAML + schema + effective (viewer allowed) ─────────
    const get = await req("GET", CFG, { session: viewerSess });
    ok("GET config(viewer) → 200", get.status === 200);
    ok("GET includes raw yaml", typeof get.json.data.yaml === "string" && get.json.data.yaml.includes("profile: chill"));
    ok("GET includes schema (object w/ properties)", get.json.data.schema?.type === "object" && !!get.json.data.schema?.properties?.reviews);
    ok("GET includes merged effective config", get.json.data.effective?.chat?.auto_reply === true);
    ok("GET reports default branch + editable", get.json.data.defaultBranch === "main" && get.json.data.editable === true);

    // ── Unauthenticated GET is rejected (auth gate + requireRole("viewer")) ─
    const getAnon = await req("GET", CFG);
    ok("GET config(unauthenticated) → 401", getAnon.status === 401 && getAnon.json.error.code === "unauthorized");

    // ── PUT forbidden for viewer + author ──────────────────────────────
    const putViewer = await req("PUT", CFG, { session: viewerSess, csrf: true, body: { yaml: "reviews:\n  profile: assertive\n" } });
    ok("PUT(viewer) → 403", putViewer.status === 403 && putViewer.json.error.code === "forbidden");
    const putAuthor = await req("PUT", CFG, { session: authorSess, csrf: true, body: { yaml: "reviews:\n  profile: assertive\n" } });
    ok("PUT(author) → 403", putAuthor.status === 403);

    // ── Admin: invalid YAML blocked (no commit) ────────────────────────
    const badYaml = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: "reviews: : :\n  - [unbalanced\n" } });
    ok("PUT(admin, bad YAML) → 400", badYaml.status === 400 && /Invalid YAML/.test(badYaml.json.error.message));

    // ── Admin: schema-invalid config blocked, with field details ───────
    const badEnum = await req("PUT", CFG, {
      session: adminSess,
      csrf: true,
      body: { yaml: "reviews:\n  profile: spicy\nunknown_top: 1\n" },
    });
    ok("PUT(admin, bad config) → 400", badEnum.status === 400);
    ok(
      "PUT(admin, bad config) → field-level details",
      Array.isArray(badEnum.json.error.details) &&
        badEnum.json.error.details.some((d: any) => d.path === "reviews.profile") &&
        badEnum.json.error.details.some((d: any) => d.path === "unknown_top"),
    );

    const callsBefore = calls.filter((c) => c.method === "repos.createOrUpdateFileContents").length;
    ok("invalid configs committed nothing", callsBefore === 0);

    // ── Admin: valid direct commit ─────────────────────────────────────
    const newYaml = "reviews:\n  profile: assertive\n  high_level_summary: false\n";
    const commit = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: newYaml, mode: "commit", message: "tighten review" } });
    ok("PUT(admin, commit) → 200 mode=commit", commit.status === 200 && commit.json.data.mode === "commit");
    const wrote = calls.find((c) => c.method === "repos.createOrUpdateFileContents");
    ok("commit → createOrUpdateFileContents on main", !!wrote && (wrote.args[0] as any).branch === "main" && (wrote.args[0] as any).path === ".diffsentry.yaml");

    // ── Audit + bus ────────────────────────────────────────────────────
    const audit = getAuditLog({ limit: 50, offset: 0 });
    const cfgRow = audit.rows.find((r: any) => r.action === "config.update" && r.result === "ok");
    ok("audit_log has config.update (ok) by admin", !!cfgRow && cfgRow.actor_login === "adminuser" && cfgRow.target_ref === "acme/web");
    ok("audit payload carries a diff", !!cfgRow && /high_level_summary/.test(cfgRow.payload_json ?? ""));
    ok("bus emitted config.updated (commit)", await waitForEvent((e) => e.topic === "config.updated" && e.payload.mode === "commit"));

    // ── Cache invalidated: next GET reflects the new commit ────────────
    const getAfter = await req("GET", CFG, { session: adminSess });
    ok("GET after commit reflects new YAML (cache invalidated)", getAfter.json.data.yaml.includes("high_level_summary: false"));

    // ── PR mode: branch + PR, not a default-branch commit ──────────────
    const prRes = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: "chat:\n  auto_reply: false\n", mode: "pr" } });
    ok("PUT(admin, pr) → 200 mode=pr", prRes.status === 200 && prRes.json.data.mode === "pr" && prRes.json.data.prNumber === 99);
    ok("pr → git.createRef + pulls.create called", calls.some((c) => c.method === "git.createRef") && calls.some((c) => c.method === "pulls.create"));
    ok("bus emitted config.updated (pr)", await waitForEvent((e) => e.topic === "config.updated" && e.payload.mode === "pr"));

    // ── PR branch collision (422) is retried with a fresh name ─────────
    failCreateRefOnce = true;
    const refsBefore = calls.filter((c) => c.method === "git.createRef").length;
    const prRetry = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: "chat:\n  auto_reply: true\n", mode: "pr" } });
    const refsAfter = calls.filter((c) => c.method === "git.createRef").length;
    ok("pr branch 422 → retried + succeeds", prRetry.status === 200 && prRetry.json.data.mode === "pr" && refsAfter - refsBefore === 2);

    // ── A failure after branch creation cleans up the orphaned branch ──
    failPullsCreateOnce = true;
    const delBefore = calls.filter((c) => c.method === "git.deleteRef").length;
    const prFail = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: "chat:\n  auto_reply: false\n", mode: "pr" } });
    const delAfter = calls.filter((c) => c.method === "git.deleteRef").length;
    ok("pr failure after createRef → 500 + branch deleted", prFail.status === 500 && delAfter - delBefore === 1);

    // ── PR-mode reads the existing config at the SAME branch it writes to ──
    // (currentFileSha must resolve the generated, slash-containing PR branch;
    // the read ref and the write branch must match so the sha is supplied.)
    const refBase = calls.length;
    const prRef = await req("PUT", CFG, { session: adminSess, csrf: true, body: { yaml: "issues:\n  auto_summary:\n    enabled: false\n", mode: "pr" } });
    const refCalls = calls.slice(refBase);
    const writeCall = refCalls.find((c) => c.method === "repos.createOrUpdateFileContents");
    const writeBranch = (writeCall?.args[0] as { branch?: string } | undefined)?.branch;
    const readAtWriteBranch = refCalls.some(
      (c) => c.method === "repos.getContent" && (c.args[0] as { ref?: string } | undefined)?.ref === writeBranch,
    );
    ok(
      "pr-mode reads existing config at the write branch (slash-safe ref)",
      prRef.status === 200 && typeof writeBranch === "string" && writeBranch.includes("/") && readAtWriteBranch,
    );

    // ── Transient GitHub errors are NOT cached as "no config" ──────────
    // First GET hits a one-shot 500 → null (uncached); the next GET recovers.
    transientFail = true;
    const transient1 = await req("GET", "/repos/acme/transient/config", { session: adminSess });
    ok("GET during transient error → yaml null", transient1.status === 200 && transient1.json.data.yaml === null);
    const transient2 = await req("GET", "/repos/acme/transient/config", { session: adminSess });
    ok("GET after transient error recovers (null not cached)", transient2.json.data.yaml !== null && /profile:/.test(transient2.json.data.yaml));

    // ── CSRF enforced ──────────────────────────────────────────────────
    const noCsrf = await req("PUT", CFG, { session: adminSess, body: { yaml: "chat:\n  auto_reply: true\n" } });
    ok("PUT(admin, no CSRF) → 403", noCsrf.status === 403);

    // ── No installation → 404 ──────────────────────────────────────────
    const ghost = await req("PUT", "/repos/ghost/repo/config", { session: adminSess, csrf: true, body: { yaml: "chat:\n  auto_reply: true\n" } });
    ok("PUT(no installation) → 404", ghost.status === 404 && ghost.json.error.code === "not_found");

    console.log("\nall config smoke checks passed ✓");
  } finally {
    if (sse) sse.destroy();
    if (server) {
      const s = server;
      // Wait for the HTTP server to fully stop before closing the DB so no
      // in-flight handler touches a closed database.
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    if (closeDatabase) closeDatabase();
    if (tmpDb) {
      try {
        fs.unlinkSync(tmpDb);
      } catch {
        // best effort
      }
    }
    if (learningsDir) {
      try {
        fs.rmSync(learningsDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
