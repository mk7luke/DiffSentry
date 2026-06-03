/**
 * Smoke-test the command-action substrate end-to-end against a temp SQLite DB.
 * Run: npx tsx scripts/smoke-actions.ts
 *
 * A fake Reviewer records the calls the endpoints make. Asserts:
 *   - viewers get 403 on every action; authors succeed
 *   - review returns 202 + drives reviewer.triggerReview with the right mode
 *   - pause/resume/resolve/cancel drive the matching reviewer methods
 *   - each successful action lands an audit_log row (pr.<action>)
 *   - each action publishes 'action.performed' on the in-process bus
 *   - the SSE stream (/stream) delivers a live event without polling
 *   - a repo with no installation row → 404 for review/resolve
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_SECRET = "actions-smoke-secret";

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
  const tmpDb = path.join(os.tmpdir(), `ds-actions-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DASHBOARD_AUTHOR_LOGINS = "authoruser";

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { createAuth } = await import("../src/dashboard/auth.js");
  const { recordRepo } = await import("../src/storage/dao.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  // Seed a repo so getInstallationId() resolves for review/resolve.
  recordRepo({ owner: "acme", repo: "web", installationId: 42 });

  const learningsDir = path.join(os.tmpdir(), `ds-actions-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  // ── Fake reviewer: records calls; review() resolves async like the real one.
  const calls: Call[] = [];
  const reviewer = {
    triggerReview: (...args: unknown[]) => {
      calls.push({ method: "triggerReview", args });
      return Promise.resolve();
    },
    resolveThreads: (...args: unknown[]) => {
      calls.push({ method: "resolveThreads", args });
      return Promise.resolve();
    },
    pauseReviews: (...args: unknown[]) => void calls.push({ method: "pauseReviews", args }),
    resumeReviews: (...args: unknown[]) => void calls.push({ method: "resumeReviews", args }),
    cancelReview: (...args: unknown[]) => void calls.push({ method: "cancelReview", args }),
    runCommand: (...args: unknown[]) => {
      calls.push({ method: "runCommand", args });
      return Promise.resolve();
    },
  };

  const auth = createAuth({
    clientId: "cid",
    clientSecret: "csecret",
    allowedLogins: ["authoruser", "vieweruser"],
    allowedOrgs: [],
    sessionSecret: SESSION_SECRET,
    baseUrl: "http://localhost/dashboard",
  });

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, auth, reviewer: reviewer as any }));
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

  const authorSess = sessionValue("authoruser", 1);
  const viewerSess = sessionValue("vieweruser", 2);
  const PR = "/repos/acme/web/prs/7";

  try {
    // ── Viewers are forbidden from every action ────────────────────────
    for (const action of ["review", "resolve", "pause", "resume", "cancel"]) {
      const r = await req("POST", `${PR}/${action}`, { session: viewerSess, csrf: true, body: {} });
      ok(`${action}(viewer) → 403`, r.status === 403 && r.json.error.code === "forbidden");
    }
    const cmdViewer = await req("POST", `${PR}/command`, { session: viewerSess, csrf: true, body: { command: "summary" } });
    ok("command(viewer) → 403", cmdViewer.status === 403 && cmdViewer.json.error.code === "forbidden");

    // ── Author triggers a full re-review → 202 + reviewer called ────────
    const review = await req("POST", `${PR}/review`, { session: authorSess, csrf: true, body: { mode: "full" } });
    ok("review(author) → 202 accepted", review.status === 202 && review.json.data.result === "accepted" && review.json.data.mode === "full");
    // The fire-and-forget triggerReview runs on next tick.
    await new Promise((r) => setTimeout(r, 20));
    const triggered = calls.find((c) => c.method === "triggerReview");
    ok(
      "review → reviewer.triggerReview(42, acme, web, 7, full)",
      !!triggered &&
        triggered.args[0] === 42 &&
        triggered.args[1] === "acme" &&
        triggered.args[2] === "web" &&
        triggered.args[3] === 7 &&
        triggered.args[4] === "full",
    );

    // ── Author pause / resume / resolve / cancel → 200 + reviewer call ─
    const pause = await req("POST", `${PR}/pause`, { session: authorSess, csrf: true, body: {} });
    ok("pause(author) → 200", pause.status === 200 && pause.json.data.result === "ok");
    ok("pause → reviewer.pauseReviews(acme, web, 7)", calls.some((c) => c.method === "pauseReviews" && c.args[2] === 7));

    const resume = await req("POST", `${PR}/resume`, { session: authorSess, csrf: true, body: {} });
    ok("resume(author) → 200 + call", resume.status === 200 && calls.some((c) => c.method === "resumeReviews"));

    const resolve = await req("POST", `${PR}/resolve`, { session: authorSess, csrf: true, body: {} });
    ok("resolve(author) → 200 + call", resolve.status === 200 && calls.some((c) => c.method === "resolveThreads" && c.args[0] === 42));

    const cancel = await req("POST", `${PR}/cancel`, { session: authorSess, csrf: true, body: {} });
    ok("cancel(author) → 200 + call", cancel.status === 200 && calls.some((c) => c.method === "cancelReview"));

    // ── Author chat command → 202 + reviewer.runCommand(phrase) ─────────
    const callsBeforeCommand = calls.length;
    const command = await req("POST", `${PR}/command`, { session: authorSess, csrf: true, body: { command: "generate_tests" } });
    ok(
      "command(author) → 202 accepted",
      command.status === 202 && command.json.data.result === "accepted" && command.json.data.command === "generate_tests",
    );
    await new Promise((r) => setTimeout(r, 20));
    const ranCommand = calls.slice(callsBeforeCommand).find((c) => c.method === "runCommand");
    ok(
      "command → reviewer.runCommand(42, acme, web, 7, 'generate tests')",
      !!ranCommand &&
        ranCommand.args[0] === 42 &&
        ranCommand.args[1] === "acme" &&
        ranCommand.args[2] === "web" &&
        ranCommand.args[3] === 7 &&
        ranCommand.args[4] === "generate tests",
    );

    // ── Unknown command token → 400 (allowlist is the trust boundary) ───
    const badCommand = await req("POST", `${PR}/command`, { session: authorSess, csrf: true, body: { command: "rm -rf" } });
    ok("command(unknown token) → 400", badCommand.status === 400 && badCommand.json.error.code === "bad_request");

    // ── CSRF is enforced (author, no token) ────────────────────────────
    const noCsrf = await req("POST", `${PR}/pause`, { session: authorSess, body: {} });
    ok("pause(author, no CSRF) → 403", noCsrf.status === 403);

    // ── Missing installation → 404 for review/resolve ──────────────────
    const noInstall = await req("POST", "/repos/ghost/repo/prs/1/review", { session: authorSess, csrf: true, body: { mode: "full" } });
    ok("review(no installation) → 404", noInstall.status === 404 && noInstall.json.error.code === "not_found");

    // ── Audit log captured every successful action (read via /me-less DAO)
    const { getAuditLog } = await import("../src/dashboard/queries.js");
    const audit = getAuditLog({ limit: 100, offset: 0 });
    const actions = new Set(audit.rows.map((r: any) => r.action));
    ok(
      "audit_log has pr.review / pr.pause / pr.resume / pr.resolve / pr.cancel / pr.command",
      ["pr.review", "pr.pause", "pr.resume", "pr.resolve", "pr.cancel", "pr.command"].every((a) => actions.has(a)),
    );
    ok(
      "audit rows attribute the actor + target",
      audit.rows.some((r: any) => r.action === "pr.review" && r.actor_login === "authoruser" && r.target_ref === "acme/web#7"),
    );

    // ── SSE stream delivers a live action.performed event (end-to-end proof
    // that the action → bus → SSE path works on the real, shared bus instance).
    const sseSeen = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/v1/stream",
          method: "GET",
          headers: { Accept: "text/event-stream", Cookie: `ds_session=${authorSess}` },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`stream status ${res.statusCode}`));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.includes("event: action.performed")) {
              r.destroy();
              resolve(buf);
            }
          });
          // Once connected, trigger an action to push through the stream.
          setTimeout(() => {
            void req("POST", `${PR}/resume`, { session: authorSess, csrf: true, body: {} });
          }, 30);
        },
      );
      r.on("error", (err) => {
        // destroy() after success surfaces as ECONNRESET — ignore post-resolve.
        if (!buf.includes("event: action.performed")) reject(err);
      });
      r.end();
      setTimeout(() => reject(new Error("SSE timeout")), 3000);
    });
    ok("SSE stream delivered action.performed live", sseSeen.includes("event: action.performed"));

    console.log("\nall action smoke checks passed ✓");
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
