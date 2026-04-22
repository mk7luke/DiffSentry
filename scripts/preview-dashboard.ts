/**
 * Stand up the dashboard on a fixed port with seeded data for visual review.
 * Run: PORT=8091 DB_PATH=/tmp/ds-preview.db npx tsx scripts/preview-dashboard.ts
 */
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-preview-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createDashboardRouter } = await import("../src/dashboard/routes.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open db");

  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const hoursAgo = (h: number) => iso(new Date(now.getTime() - h * 3_600_000));
  const daysAgo = (d: number) => iso(new Date(now.getTime() - d * 86_400_000));

  // Repos
  const repos = [
    { owner: "interact", repo: "atlas", hoursOld: 2, installationId: 1 },
    { owner: "interact", repo: "ledger", hoursOld: 6, installationId: 1 },
    { owner: "mk7luke", repo: "diffsentry-sandbox", hoursOld: 1, installationId: 2 },
    { owner: "mk7luke", repo: "DiffSentry", hoursOld: 24, installationId: 2 },
    { owner: "mk7luke", repo: "jarvis", hoursOld: 72, installationId: 2 },
    { owner: "mk7luke", repo: "DiffSentry-site", hoursOld: 120, installationId: 2 },
    { owner: "corp", repo: "old-service", hoursOld: 1200, installationId: 3 },
    { owner: "corp", repo: "dormant", hoursOld: 5000, installationId: 3 },
  ];
  for (const r of repos) {
    db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`)
      .run(r.owner, r.repo, r.installationId, daysAgo(60), hoursAgo(r.hoursOld));
  }

  // PRs + reviews scattered across the last 14 days
  const prInsert = db.prepare(
    `INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rvInsert = db.prepare(
    `INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const findingInsert = db.prepare(
    `INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const hitInsert = db.prepare(
    `INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?,?,?,?,?,?)`,
  );
  const eventInsert = db.prepare(
    `INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?,?,?,?,?,?)`,
  );

  let prNo = 100;
  const titles = [
    "Add rate limiter",
    "Fix race condition in counter",
    "Refactor session storage",
    "Wire trace logging into request handler",
    "Add Levenshtein distance helper",
    "Add session expiry sweep",
    "Faster login: parallel session fetch",
    "Extract validation into middleware",
    "Update dependencies",
    "Add card component",
    "Migrate to new API version",
    "Fix typo in README",
    "Polish empty states",
    "Revamp admin dashboard",
    "Investigate flaky test",
  ];
  const authors = ["alice", "bob", "mk7luke", "carol", "dave"];
  const paths = [
    "src/api/handler.ts",
    "src/auth/session.ts",
    "src/limiter.ts",
    "src/ui/dashboard.tsx",
    "migrations/2026_03_rate_limiter.sql",
    "src/server.ts",
    "scripts/staging-deploy.sh",
    "package.json",
  ];
  const severities: Array<"critical" | "major" | "minor" | "nit"> = ["critical", "major", "minor", "nit"];
  const approvals = ["approve", "approve", "approve", "comment", "request_changes"];
  const profiles = ["chill", "chill", "strict", "assertive"];

  const rand = (mod: number) => Math.floor(Math.random() * mod);

  for (const r of repos) {
    const prsForRepo = r.hoursOld < 200 ? 14 : r.hoursOld < 500 ? 4 : r.hoursOld < 2000 ? 1 : 0;
    for (let i = 0; i < prsForRepo; i++) {
      const number = ++prNo;
      const hOld = r.hoursOld + i * 8 + rand(20);
      const title = titles[(prNo + i) % titles.length];
      const author = authors[rand(authors.length)];
      prInsert.run(r.owner, r.repo, number, title, author, i < 4 ? "open" : "closed", "b".repeat(7), "h".repeat(7), hoursAgo(hOld));
      eventInsert.run(r.owner, r.repo, number, hoursAgo(hOld + 1), "pull_request.opened", null);
      eventInsert.run(r.owner, r.repo, number, hoursAgo(hOld), "pull_request_review.submitted", null);

      const riskScore = Math.min(95, Math.max(5, 35 + rand(50) - rand(25)));
      const riskLevel =
        riskScore >= 80 ? "critical"
        : riskScore >= 60 ? "high"
        : riskScore >= 40 ? "elevated"
        : riskScore >= 20 ? "moderate"
        : "low";
      const approval = riskScore >= 70 ? "request_changes" : approvals[rand(approvals.length)];
      const summary = `## Summary\n\nReviewed ${rand(6) + 1} files. ${riskScore >= 70 ? "Found material issues." : "Looks reasonable overall."}\n\n- **${rand(4) + 1}** findings\n- Files processed: ${rand(8) + 2}\n`;
      const rvId = rvInsert
        .run(
          r.owner, r.repo, number, "sha_" + number,
          profiles[rand(profiles.length)],
          approval, summary,
          riskScore, riskLevel,
          rand(10) + 1, rand(3), rand(2),
          hoursAgo(hOld),
        ).lastInsertRowid as number;

      const numFindings = riskScore >= 70 ? 3 + rand(3) : rand(4);
      for (let k = 0; k < numFindings; k++) {
        const sev = riskScore >= 75 && k === 0 ? "critical"
          : riskScore >= 55 && k === 0 ? "major"
          : severities[rand(severities.length)];
        findingInsert.run(
          rvId,
          paths[rand(paths.length)],
          rand(400) + 1,
          "issue",
          sev,
          `Finding ${k + 1} — ${title.toLowerCase()}`,
          `There's a subtle issue on this line. Consider the null case.`,
          `fp_${title.slice(0, 8).replace(/\W/g, "")}_${k}`,
          rand(2) === 0 ? "ai" : rand(2) === 0 ? "safety" : "builtin",
          rand(2) === 0 ? "high" : "medium",
        );
      }
      if (rand(2) === 0) {
        const rules = ["no-console", "async-callback-foreach", "setInterval-no-handle", "img-no-alt", "onClick-on-non-interactive"];
        hitInsert.run(r.owner, r.repo, rules[rand(rules.length)], "builtin", `fp_p_${number}_${rand(9999)}`, rvId);
      }
    }
  }

  // Learnings for one repo
  const learningsDir = path.join(os.tmpdir(), `ds-preview-learnings-${Date.now()}`);
  fs.mkdirSync(path.join(learningsDir, "mk7luke"), { recursive: true });
  fs.writeFileSync(
    path.join(learningsDir, "mk7luke", "diffsentry-sandbox.json"),
    JSON.stringify([
      { id: "l1", repo: "mk7luke/diffsentry-sandbox", content: "Prefer async/await over raw promises — our retry shim expects awaitable returns.", createdAt: daysAgo(10) },
      { id: "l2", repo: "mk7luke/diffsentry-sandbox", content: "Tests must hit a real SQLite DB (see /tests/e2e). Mocked DB tests have masked real migrations bugs.", path: "tests/**", createdAt: daysAgo(2) },
      { id: "l3", repo: "mk7luke/diffsentry-sandbox", content: "Never commit .env files even with fake values.", createdAt: daysAgo(20) },
    ]),
  );

  const app = express();
  app.use("/dashboard", createDashboardRouter({ learningsDir }));

  const port = Number.parseInt(process.env.PORT ?? "8091", 10);
  app.listen(port, () => {
    console.log(`\n  ┌─────────────────────────────────────────────┐`);
    console.log(`  │  DiffSentry preview                         │`);
    console.log(`  │  http://localhost:${port}/dashboard           │`);
    console.log(`  │                                             │`);
    console.log(`  │  ${repos.length} repos · ${prNo - 100} PRs · ${learningsDir.length > 0 ? "learnings seeded" : ""}  │`);
    console.log(`  └─────────────────────────────────────────────┘\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
