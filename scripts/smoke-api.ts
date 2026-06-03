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
  const f1Id = Number(insertFinding.run(r1, "src/limiter.ts", 42, "issue", "critical", "Race condition", "Concurrent access to counter is unsynchronized.", "fp1", "ai", "high").lastInsertRowid);
  insertFinding.run(r1, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");
  insertFinding.run(r4owner, "src/auth.ts", 5, "security", "critical", "Secret in code", "Hardcoded token.", "fp4", "safety", "high");
  // A second finding sharing fingerprint fp2 on a *different* repo/PR so the
  // recurring view has a genuine 2-occurrence, 2-repo, 2-PR class to group.
  insertFinding.run(r4owner, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");

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

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir }));
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

  async function post(pathname: string, body: unknown): Promise<{ status: number; json: any }> {
    return await new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request(
        { hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              reject(new Error(`non-JSON body for POST ${pathname}: ${text.slice(0, 120)}`));
              return;
            }
            resolve({ status: r.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
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

    // ── Triage: single finding ───────────────────────────────────────
    const triage1 = await post(`/api/v1/findings/${f1Id}/triage`, { state: "dismissed", note: "false positive" });
    ok("triage single → 200 changed", triage1.status === 200 && triage1.json.data.changed === 1 && triage1.json.data.state === "dismissed");

    const afterDismiss = await get(`/api/v1/findings?triage=dismissed`);
    ok(
      "triage persisted → finding now dismissed",
      afterDismiss.status === 200 &&
        afterDismiss.json.data.rows.some((f: any) => f.id === f1Id && f.accepted === 0 && f.triage_note === "false positive"),
    );

    // Idempotent re-apply changes nothing (survives reload / repeat).
    const triage1Again = await post(`/api/v1/findings/${f1Id}/triage`, { state: "dismissed", note: "false positive" });
    ok("triage idempotent → 0 changed on repeat", triage1Again.status === 200 && triage1Again.json.data.changed === 0);

    // Snooze requires a future date; a past one is rejected.
    const badSnooze = await post(`/api/v1/findings/${f1Id}/triage`, { state: "snoozed", until: "2000-01-01" });
    ok("snooze past date → 400", badSnooze.status === 400 && badSnooze.json.error.code === "bad_request");

    const unknownTriage = await post(`/api/v1/findings/999999/triage`, { state: "accepted" });
    ok("triage unknown id → 404", unknownTriage.status === 404 && unknownTriage.json.error.code === "not_found");

    // ── Recurring view groups by fingerprint ──────────────────────────
    const recurring = await get(`/api/v1/findings/recurring`);
    const fp2group = recurring.json?.data?.rows?.find((g: any) => g.fingerprint === "fp2");
    ok(
      "recurring → fp2 grouped (2 occurrences, 2 repos, 2 PRs)",
      recurring.status === 200 && !!fp2group && fp2group.occurrences === 2 && fp2group.repos === 2 && fp2group.prs === 2,
    );

    // Filtered recurring query — proves buildFindingsWhere params bind in the
    // right placeholder order alongside the SELECT's `now` and HAVING/LIMIT.
    const recurringMajor = await get(`/api/v1/findings/recurring?severity=major`);
    ok(
      "recurring?severity=major → fp2 only (major class)",
      recurringMajor.status === 200 &&
        recurringMajor.json.data.rows.some((g: any) => g.fingerprint === "fp2" && g.severity === "major") &&
        recurringMajor.json.data.rows.every((g: any) => g.severity === "major"),
    );
    const recurringCritical = await get(`/api/v1/findings/recurring?severity=critical`);
    ok(
      "recurring?severity=critical → excludes the major fp2 class",
      recurringCritical.status === 200 && !recurringCritical.json.data.rows.some((g: any) => g.fingerprint === "fp2"),
    );

    // ── Bulk triage a whole fingerprint class ─────────────────────────
    const bulk = await post(`/api/v1/findings/triage`, { fingerprint: "fp2", state: "accepted", note: "known + acceptable" });
    ok(
      "bulk triage by fingerprint → 2 matched/changed",
      bulk.status === 200 && bulk.json.data.changed === 2 && bulk.json.data.requested === 2 && bulk.json.data.matched === 2,
    );

    const recurringAfter = await get(`/api/v1/findings/recurring`);
    const fp2after = recurringAfter.json.data.rows.find((g: any) => g.fingerprint === "fp2");
    ok("recurring rollup → fp2 accepted_count = 2", !!fp2after && fp2after.accepted_count === 2);

    const bulkEmpty = await post(`/api/v1/findings/triage`, { state: "accepted" });
    ok("bulk triage with no targets → 400", bulkEmpty.status === 400 && bulkEmpty.json.error.code === "bad_request");

    const bulkMalformed = await post(`/api/v1/findings/triage`, { ids: [f1Id, "abc", -3], state: "accepted" });
    ok("bulk triage malformed ids → 400 (not silently dropped)", bulkMalformed.status === 400 && bulkMalformed.json.error.code === "bad_request");

    const bulkMissing = await post(`/api/v1/findings/triage`, { ids: [987654, 987655], state: "accepted" });
    ok("bulk triage non-existent ids → 404", bulkMissing.status === 404 && bulkMissing.json.error.code === "not_found");

    // De-dup: a repeated id is counted once (matched/requested both 1).
    const bulkDedup = await post(`/api/v1/findings/triage`, { ids: [f1Id, f1Id], state: "dismissed" });
    ok("bulk triage dedups repeated ids → matched 1", bulkDedup.status === 200 && bulkDedup.json.data.matched === 1 && bulkDedup.json.data.requested === 1);

    // ── Triage shows in the audit log ─────────────────────────────────
    const audit = await get(`/api/v1/audit`);
    ok(
      "audit log → finding.triage rows present",
      audit.status === 200 && audit.json.data.rows.some((r: any) => r.action === "finding.triage"),
    );

    const patterns = await get("/api/v1/patterns");
    ok("patterns → rules", patterns.status === 200 && patterns.json.data.rules.some((r: any) => r.rule_name === "no-console"));

    const health = await get("/api/v1/health");
    ok("health → counts + logs", health.status === 200 && health.json.data.counts.repos === 2 && Array.isArray(health.json.data.logs));

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
