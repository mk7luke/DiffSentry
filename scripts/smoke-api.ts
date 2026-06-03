/**
 * Smoke-test the JSON API (/api/v1) against a temp SQLite DB seeded with
 * sample rows. Run: npx tsx scripts/smoke-api.ts
 *
 * Mirrors scripts/smoke-dashboard.ts but asserts on the JSON envelope shape
 * rather than rendered HTML, and checks the auth gate returns 401 JSON.
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-api-smoke-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");

  const now = new Date().toISOString();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run("mk7luke", "diffsentry-sandbox", 1, hoursAgo(240), now);
  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run("mk7luke", "other-repo", 1, hoursAgo(500), hoursAgo(72));

  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("mk7luke", "diffsentry-sandbox", 42, "Add rate limiter", "alice", "open", "aaaaaaa", "bbbbbbb", hoursAgo(10));

  const r1 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("mk7luke", "diffsentry-sandbox", 42, "bbbbbbb", "chill", "request_changes", "Two critical findings on the rate limiter.", 82, "critical", 6, 0, 0, hoursAgo(9)).lastInsertRowid;
  const r4owner = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("mk7luke", "other-repo", 7, "ffff", "assertive", "comment", "Security-adjacent refactor.", 42, "elevated", 4, 0, 0, hoursAgo(79)).lastInsertRowid;

  const insertFinding = db.prepare(`INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertFinding.run(r1, "src/limiter.ts", 42, "issue", "critical", "Race condition", "Concurrent access to counter is unsynchronized.", "fp1", "ai", "high");
  insertFinding.run(r1, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");
  insertFinding.run(r4owner, "src/auth.ts", 5, "security", "critical", "Secret in code", "Hardcoded token.", "fp4", "safety", "high");

  const insertHit = db.prepare(`INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?,?,?,?,?,?)`);
  insertHit.run("mk7luke", "diffsentry-sandbox", "no-console", "builtin", "fp-x1", r1);

  const insertEvent = db.prepare(`INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?,?,?,?,?,?)`);
  insertEvent.run("mk7luke", "diffsentry-sandbox", 42, hoursAgo(10), "pull_request.opened", null);

  const learningsDir = path.join(os.tmpdir(), `ds-api-smoke-learnings-${Date.now()}`);
  fs.mkdirSync(path.join(learningsDir, "mk7luke"), { recursive: true });
  fs.writeFileSync(
    path.join(learningsDir, "mk7luke", "diffsentry-sandbox.json"),
    JSON.stringify([{ id: "l1", repo: "mk7luke/diffsentry-sandbox", content: "Prefer async/await.", createdAt: hoursAgo(240) }]),
  );

  // Webhook secret so the diagnostics webhook self-test can round-trip.
  process.env.GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "smoke-secret";

  // Stub the diagnostics provider — the smoke harness has no real Reviewer, so
  // we inject canned probe results (the route wiring + envelope is what we test).
  const diagnosticsStub = {
    aiTarget: () => ({ provider: "anthropic", model: "claude-test" }),
    testAiProvider: async () => ({ ok: true, provider: "anthropic", model: "claude-test", latencyMs: 5, reply: "pong" }),
    getGithubDiagnostics: async () => ({
      app: { slug: "diffsentry", name: "DiffSentry", htmlUrl: "https://github.com/apps/diffsentry" },
      installations: [
        { id: 1, account: "mk7luke", accountType: "User", repositorySelection: "selected", repos: ["mk7luke/diffsentry-sandbox"], repoCount: 1, truncated: false },
      ],
      webhook: { configuredUrl: "https://example.com/webhook", deliveries: [{ id: 1, event: "pull_request", action: "opened", status: "OK", statusCode: 200, deliveredAt: now, redelivery: false }] },
      rateLimit: { limit: 5000, remaining: 4999, reset: now },
    }),
  };

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, diagnostics: diagnosticsStub }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  async function get(pathname: string): Promise<{ status: number; json: any }> {
    return await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}${pathname}`, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try {
              json = body ? JSON.parse(body) : null;
            } catch {
              reject(new Error(`non-JSON body for ${pathname}: ${body.slice(0, 120)}`));
              return;
            }
            resolve({ status: r.statusCode ?? 0, json });
          });
        })
        .on("error", reject);
    });
  }

  async function post(pathname: string): Promise<{ status: number; json: any }> {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${pathname}`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try {
              json = body ? JSON.parse(body) : null;
            } catch {
              reject(new Error(`non-JSON body for POST ${pathname}: ${body.slice(0, 120)}`));
              return;
            }
            resolve({ status: r.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function ok(label: string, cond: boolean) {
    if (!cond) throw new Error(`[${label}] assertion failed`);
    console.log(`  ✓ ${label}`);
  }

  try {
    const me = await get("/api/v1/me");
    ok(
      "me → 200 envelope (local admin + capabilities)",
      me.status === 200 &&
        me.json.data.user.role === "admin" &&
        me.json.data.user.capabilities.viewAudit === true &&
        me.json.data.authEnabled === false,
    );

    const repos = await get("/api/v1/repos");
    ok(
      "repos → list + activity",
      repos.status === 200 &&
        Array.isArray(repos.json.data.repos) &&
        repos.json.data.repos.some((r: any) => r.repo === "diffsentry-sandbox") &&
        Array.isArray(repos.json.data.activity),
    );

    const detail = await get("/api/v1/repos/mk7luke/diffsentry-sandbox");
    ok(
      "repo detail → all sections",
      detail.status === 200 &&
        detail.json.data.hotPaths.some((p: any) => p.path === "src/limiter.ts") &&
        detail.json.data.topRules.some((r: any) => r.rule_name === "no-console") &&
        detail.json.data.prs.some((p: any) => p.number === 42) &&
        detail.json.data.learnings.length === 1,
    );

    const pr = await get("/api/v1/repos/mk7luke/diffsentry-sandbox/prs/42");
    ok(
      "pr detail → pr + findings + events",
      pr.status === 200 &&
        pr.json.data.pr.title === "Add rate limiter" &&
        pr.json.data.findings.some((f: any) => f.title === "Race condition") &&
        pr.json.data.events.some((e: any) => e.kind === "pull_request.opened"),
    );

    const findings = await get("/api/v1/findings");
    ok("findings → rows + total", findings.status === 200 && findings.json.data.total >= 3);

    const filtered = await get("/api/v1/findings?severity=critical&source=safety");
    ok(
      "findings filtered → only matching",
      filtered.status === 200 &&
        filtered.json.data.rows.every((f: any) => f.severity === "critical" && f.source === "safety") &&
        filtered.json.data.rows.some((f: any) => f.title === "Secret in code"),
    );

    const patterns = await get("/api/v1/patterns");
    ok("patterns → rules", patterns.status === 200 && patterns.json.data.rules.some((r: any) => r.rule_name === "no-console"));

    const health = await get("/api/v1/health");
    ok("health → counts + logs", health.status === 200 && health.json.data.counts.repos === 2 && Array.isArray(health.json.data.logs));

    // ── Diagnostics (first-run experience) ─────────────────────────
    const diag = await get("/api/v1/diagnostics");
    ok(
      "diagnostics → checks + summary + config + db",
      diag.status === 200 &&
        Array.isArray(diag.json.data.checks) &&
        diag.json.data.checks.length > 0 &&
        diag.json.data.checks.some((c: any) => c.id === "ai.provider") &&
        typeof diag.json.data.summary.fail === "number" &&
        diag.json.data.config.provider === "anthropic" &&
        diag.json.data.db.enabled === true,
    );

    const ghd = await get("/api/v1/diagnostics/github");
    ok(
      "diagnostics/github → installations + reachable + counts",
      ghd.status === 200 &&
        ghd.json.data.reachable === true &&
        ghd.json.data.installationCount === 1 &&
        ghd.json.data.connectedRepos === 1 &&
        ghd.json.data.installations[0].repos[0] === "mk7luke/diffsentry-sandbox",
    );

    const testAi = await post("/api/v1/diagnostics/test-ai");
    ok(
      "diagnostics test-ai → ok (open-mode admin passes author gate + noop CSRF)",
      testAi.status === 200 && testAi.json.data.ok === true && testAi.json.data.reply === "pong",
    );

    const testWh = await post("/api/v1/diagnostics/test-webhook");
    ok(
      "diagnostics test-webhook → signature round-trip verified",
      testWh.status === 200 && testWh.json.data.ok === true && testWh.json.data.secretConfigured === true,
    );

    const missing = await get("/api/v1/repos/unknown/unknown");
    ok("unknown repo → 404 JSON", missing.status === 404 && missing.json.error.code === "not_found");

    const badPr = await get("/api/v1/repos/mk7luke/diffsentry-sandbox/prs/abc");
    ok("bad PR number → 400 JSON", badPr.status === 400 && badPr.json.error.code === "bad_request");

    const unknownEndpoint = await get("/api/v1/nope");
    ok("unknown endpoint → 404 JSON", unknownEndpoint.status === 404 && unknownEndpoint.json.error.code === "not_found");

    // Auth gate — a second app with auth wired returns 401 JSON (not a redirect)
    // for an unauthenticated request.
    const { createAuth } = await import("../src/dashboard/auth.js");
    const authedApp = express();
    authedApp.use(
      "/api/v1",
      createApiRouter({
        learningsDir,
        auth: createAuth({
          clientId: "cid",
          clientSecret: "csecret",
          allowedLogins: ["mk7luke"],
          allowedOrgs: [],
          sessionSecret: "smoke-secret",
          baseUrl: "http://localhost/dashboard",
        }),
      }),
    );
    const authedServer = authedApp.listen(0);
    const authedPort = (authedServer.address() as { port: number }).port;
    const authResp = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      http
        .get({ hostname: "127.0.0.1", port: authedPort, path: "/api/v1/repos" }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ status: r.statusCode ?? 0, json: body ? JSON.parse(body) : null });
          });
        })
        .on("error", reject);
    });
    authedServer.close();
    ok("auth gate → 401 JSON unauthorized", authResp.status === 401 && authResp.json.error.code === "unauthorized");

    console.log("\nall api smoke checks passed ✓");
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
