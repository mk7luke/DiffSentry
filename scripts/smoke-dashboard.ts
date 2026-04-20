/**
 * Smoke-test the dashboard against a temp SQLite DB seeded with sample rows.
 * Run: DB_PATH=/tmp/ds-smoke.db npx tsx scripts/smoke-dashboard.ts
 *
 * Seeds 2 repos, 3 PRs, 4 reviews, findings + pattern hits, then exercises
 * each route and asserts key markers appear in the HTML.
 */
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
const tmpDb = path.join(os.tmpdir(), `ds-smoke-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const { openDatabase, closeDatabase } = await import("../src/storage/db.js");
const { createDashboardRouter } = await import("../src/dashboard/routes.js");

const db = openDatabase();
if (!db) throw new Error("failed to open temp db");

const now = new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run("mk7luke", "diffsentry-sandbox", 1, hoursAgo(240), now);
db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run("mk7luke", "other-repo", 1, hoursAgo(500), hoursAgo(72));

db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("mk7luke", "diffsentry-sandbox", 42, "Add rate limiter", "alice", "open", "aaaaaaa", "bbbbbbb", hoursAgo(10));
db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("mk7luke", "diffsentry-sandbox", 43, "Fix typo in README", "bob", "open", "cccc", "dddd", hoursAgo(3));
db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("mk7luke", "other-repo", 7, "Refactor auth", "alice", "open", "eeee", "ffff", hoursAgo(80));

const r1 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("mk7luke", "diffsentry-sandbox", 42, "bbbbbbb", "chill", "request_changes", "Two critical findings on the rate limiter.", 82, "critical", 6, 0, 0, hoursAgo(9)).lastInsertRowid;
const r2 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("mk7luke", "diffsentry-sandbox", 42, "bbbbbbb2", "chill", "request_changes", "Incremental follow-up.", 55, "high", 2, 3, 1, hoursAgo(5)).lastInsertRowid;
const r3 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("mk7luke", "diffsentry-sandbox", 43, "dddd", "chill", "approve", "All good.", 5, "low", 1, 0, 0, hoursAgo(2)).lastInsertRowid;
const r4 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("mk7luke", "other-repo", 7, "ffff", "assertive", "comment", "Security-adjacent refactor.", 42, "elevated", 4, 0, 0, hoursAgo(79)).lastInsertRowid;

const insertFinding = db.prepare(`INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
insertFinding.run(r1, "src/limiter.ts", 42, "issue", "critical", "Race condition v1", "Concurrent access to counter is unsynchronized.", "fp1", "ai", "high");
insertFinding.run(r1, "src/limiter.ts", 88, "issue", "major", "Missing null check v1", "token may be null.", "fp2", "ai", "medium");
insertFinding.run(r2, "src/limiter.ts", 42, "issue", "critical", "Race condition", "Still unresolved after incremental push.", "fp1", "ai", "high");
insertFinding.run(r2, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");
insertFinding.run(r2, "src/server.ts", 12, "suggestion", "minor", "Extract helper", "Consider extracting this block.", "fp3", "ai", "medium");
insertFinding.run(r4, "src/auth.ts", 5, "security", "critical", "Secret in code", "Hardcoded token.", "fp4", "safety", "high");
insertFinding.run(r4, "src/auth.ts", 90, "issue", "major", "Broad exception", "except: is too broad.", "fp5", "builtin", "high");

const insertHit = db.prepare(`INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?,?,?,?,?,?)`);
insertHit.run("mk7luke", "diffsentry-sandbox", "no-console", "builtin", "fp-x1", r1);
insertHit.run("mk7luke", "diffsentry-sandbox", "no-console", "builtin", "fp-x2", r2);
insertHit.run("mk7luke", "diffsentry-sandbox", "todo-comment", "custom", "fp-x3", r3);

const insertEvent = db.prepare(`INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?,?,?,?,?,?)`);
insertEvent.run("mk7luke", "diffsentry-sandbox", 42, hoursAgo(10), "pull_request.opened", null);
insertEvent.run("mk7luke", "diffsentry-sandbox", 42, hoursAgo(9), "pull_request_review.submitted", null);
insertEvent.run("mk7luke", "diffsentry-sandbox", 42, hoursAgo(5), "pull_request.synchronize", null);

const learningsDir = path.join(os.tmpdir(), `ds-smoke-learnings-${Date.now()}`);
fs.mkdirSync(path.join(learningsDir, "mk7luke"), { recursive: true });
fs.writeFileSync(
  path.join(learningsDir, "mk7luke", "diffsentry-sandbox.json"),
  JSON.stringify([
    { id: "l1", repo: "mk7luke/diffsentry-sandbox", content: "Prefer async/await over raw promises.", createdAt: hoursAgo(240) },
    { id: "l2", repo: "mk7luke/diffsentry-sandbox", content: "Tests must hit a real DB (see /tests/e2e).", path: "tests/**", createdAt: hoursAgo(48) },
  ]),
);

const app = express();
app.use("/dashboard", createDashboardRouter({ learningsDir }));
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

async function fetch(pathname: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${pathname}`, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          resolve({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      })
      .on("error", reject);
  });
}

function assertContains(label: string, body: string, needles: string[]) {
  for (const n of needles) {
    if (!body.includes(n)) throw new Error(`[${label}] missing: ${n}`);
  }
  console.log(`  ✓ ${label}`);
}

try {
  const overview = await fetch("/dashboard");
  if (overview.status !== 200) throw new Error(`overview status ${overview.status}`);
  assertContains("overview", overview.body, [
    "mk7luke/diffsentry-sandbox",
    "mk7luke/other-repo",
    `href="/dashboard/repo/mk7luke/diffsentry-sandbox"`,
  ]);

  const sorted = await fetch("/dashboard?sort=critical_7d");
  if (sorted.status !== 200) throw new Error(`sorted status ${sorted.status}`);
  assertContains("overview sort=critical_7d", sorted.body, ["sort=critical_7d"]);

  const detail = await fetch("/dashboard/repo/mk7luke/diffsentry-sandbox");
  if (detail.status !== 200) throw new Error(`detail status ${detail.status}`);
  assertContains("repo detail", detail.body, [
    "mk7luke/diffsentry-sandbox",
    "Hot paths",
    "Top firing rules",
    "Recent reviews",
    "src/limiter.ts",
    "no-console",
    "Add rate limiter",
    "<svg",
    "Learnings (2)",
    "Prefer async/await",
    ".diffsentry.yaml",
  ]);

  const prDetail = await fetch("/dashboard/repo/mk7luke/diffsentry-sandbox/pr/42");
  if (prDetail.status !== 200) throw new Error(`pr detail status ${prDetail.status}`);
  assertContains("pr detail", prDetail.body, [
    "Add rate limiter",
    "Race condition",
    "Missing null check",
    "Events",
    "pull_request.opened",
    `https://github.com/mk7luke/diffsentry-sandbox/pull/42`,
  ]);

  const findings = await fetch("/dashboard/findings");
  if (findings.status !== 200) throw new Error(`findings status ${findings.status}`);
  assertContains("findings (unfiltered)", findings.body, [
    "Findings",
    "Race condition",
    "Secret in code",
    "Apply",
    "Severity",
  ]);

  const findingsFiltered = await fetch("/dashboard/findings?severity=critical&source=safety");
  if (findingsFiltered.status !== 200) throw new Error(`findings filtered status ${findingsFiltered.status}`);
  assertContains("findings (filtered)", findingsFiltered.body, [
    "Secret in code",
  ]);
  if (findingsFiltered.body.includes("Extract helper")) {
    throw new Error("[findings filtered] severity filter did not exclude minor finding");
  }

  const findingsByFp = await fetch("/dashboard/findings?fingerprint=fp1");
  if (findingsByFp.status !== 200) throw new Error(`findings fp status ${findingsByFp.status}`);
  assertContains("findings (fingerprint)", findingsByFp.body, ["fp1", "Race condition"]);

  const patterns = await fetch("/dashboard/patterns");
  if (patterns.status !== 200) throw new Error(`patterns status ${patterns.status}`);
  assertContains("patterns", patterns.body, ["no-console", "todo-comment", "Hits · 30d"]);

  const settings = await fetch("/dashboard/settings");
  if (settings.status !== 200) throw new Error(`settings status ${settings.status}`);
  assertContains("settings", settings.body, ["Runtime", "Storage", "ENABLE_DASHBOARD"]);

  const notFound = await fetch("/dashboard/repo/unknown/unknown");
  if (notFound.status !== 404) throw new Error(`expected 404, got ${notFound.status}`);
  console.log("  ✓ unknown repo → 404");

  const badPR = await fetch("/dashboard/repo/mk7luke/diffsentry-sandbox/pr/abc");
  if (badPR.status !== 400) throw new Error(`expected 400, got ${badPR.status}`);
  console.log("  ✓ bad PR number → 400");

  // Auth scenario — spin up a second app with auth enabled and check
  // that an unauthenticated request to / is redirected to /auth/login.
  const { createAuth } = await import("../src/dashboard/auth.js");
  const authedApp = express();
  authedApp.use(
    "/dashboard",
    createDashboardRouter({
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
  const authResp = await new Promise<{ status: number; location: string | null }>((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port: authedPort, path: "/dashboard" }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, location: (r.headers.location as string) ?? null });
      })
      .on("error", reject);
  });
  authedServer.close();
  if (authResp.status !== 302 || !(authResp.location ?? "").startsWith("/dashboard/auth/login")) {
    throw new Error(`expected redirect to /dashboard/auth/login, got ${authResp.status} -> ${authResp.location}`);
  }
  console.log("  ✓ auth: unauthenticated → redirect to /dashboard/auth/login");

  console.log("\nall smoke checks passed ✓");
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
