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

      // Roughly half of recent PRs get 1–3 follow-up review iterations so
      // the "grouped by PR" timeline has multi-iteration rows to show.
      const extraReviews = i < 8 && rand(2) === 0 ? 1 + rand(3) : 0;
      for (let it = 0; it < extraReviews; it++) {
        const followHours = Math.max(1, hOld - (it + 1) * 2 - rand(3));
        const followScore = Math.min(95, Math.max(0, riskScore - (it + 1) * 12 - rand(8)));
        const followApproval = followScore >= 60 ? "request_changes" : followScore <= 15 ? "approve" : "comment";
        const followLevel =
          followScore >= 80 ? "critical"
          : followScore >= 60 ? "high"
          : followScore >= 40 ? "elevated"
          : followScore >= 20 ? "moderate"
          : "low";
        const followId = rvInsert
          .run(
            r.owner, r.repo, number, `sha_${number}_v${it + 2}`,
            profiles[rand(profiles.length)],
            followApproval, `## Iteration ${it + 2}\n\n- ${followScore >= 60 ? "Still has open issues." : "Most prior issues addressed."}`,
            followScore, followLevel,
            rand(8) + 1, rand(3), rand(2),
            hoursAgo(followHours),
          ).lastInsertRowid as number;
        const followFindings = followScore >= 60 ? 2 + rand(2) : rand(2);
        for (let k = 0; k < followFindings; k++) {
          findingInsert.run(
            followId,
            paths[rand(paths.length)],
            rand(400) + 1,
            "issue",
            severities[rand(severities.length)],
            `Follow-up ${k + 1} — ${title.toLowerCase()}`,
            `Re-flagged after the prior round did not fully resolve.`,
            `fp_${title.slice(0, 8).replace(/\W/g, "")}_v${it + 2}_${k}`,
            "ai",
            "medium",
          );
        }
      }
    }
  }

  // Seed a handful of issues per repo so the Recent issues card has data to render.
  const issueInsert = db.prepare(
    `INSERT INTO issues (owner, repo, number, title, author, state, body, url, labels_json,
                          comment_count, created_at, first_seen_at, last_action_at, last_action_kind,
                          action_count, last_summary, last_plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const issueTitles = [
    "Rate limiter returns 429 to legitimate clients",
    "Session storage drops keys after redeploy",
    "Investigate flaky retry behavior on /api/sync",
    "Wire trace logs through the request handler",
    "DG Builder: real item images instead of Box icon",
    "OppDetail redesign — sa25 event-detail columns",
  ];
  const issueAuthors = ["alice", "bob", "carol", "dave", "mk7luke"];
  const issueActions: Array<{ k: string; w: number }> = [
    { k: "auto_summary", w: 6 },
    { k: "summary_regen", w: 2 },
    { k: "plan", w: 2 },
    { k: "chat", w: 4 },
    { k: "needs_detail", w: 1 },
    { k: "learn", w: 1 },
    { k: "paused", w: 1 },
  ];
  const pickAction = () => {
    const total = issueActions.reduce((n, a) => n + a.w, 0);
    let r = rand(total);
    for (const a of issueActions) {
      r -= a.w;
      if (r < 0) return a.k;
    }
    return "auto_summary";
  };
  let issueNo = 200;
  for (const r of repos) {
    const issuesForRepo = r.hoursOld < 200 ? 5 : r.hoursOld < 500 ? 2 : 0;
    for (let i = 0; i < issuesForRepo; i++) {
      const num = ++issueNo;
      const title = issueTitles[(num + i) % issueTitles.length];
      const author = issueAuthors[rand(issueAuthors.length)];
      const opened = r.hoursOld + i * 12 + rand(20);
      const actionKind = pickAction();
      const lastActionH = Math.max(1, opened - 1 - rand(8));
      const actionCount = 1 + rand(4);
      const summary = actionKind === "auto_summary" || actionKind === "summary_regen"
        ? `## Triage\n\n- **Severity:** ${["low", "moderate", "elevated"][rand(3)]}.\n- Likely root cause is in \`src/${["limiter", "auth", "session"][rand(3)]}.ts\`.\n- **Risk score:** ${20 + rand(60)}.\n\n### Suggested next steps\n1. Reproduce locally with the repro snippet.\n2. Add a regression test in \`tests/e2e\`.`
        : null;
      const plan = actionKind === "plan"
        ? `1. Trace the request path in \`src/api/handler.ts\`.\n2. Add structured logging at the boundary.\n3. Land a fix in a small PR + integration test.`
        : null;
      issueInsert.run(
        r.owner, r.repo, num, title, author,
        rand(4) === 0 ? "closed" : "open",
        `Issue body — ${title}\n\nReproduction:\n\n\`\`\`\nsteps to reproduce\n\`\`\`\n\nExpected vs actual differs by ~10%.`,
        `https://github.com/${r.owner}/${r.repo}/issues/${num}`,
        JSON.stringify(rand(2) === 0 ? ["bug"] : ["bug", "needs-triage"]),
        rand(8),
        hoursAgo(opened), hoursAgo(opened), hoursAgo(lastActionH), actionKind,
        actionCount, summary, plan,
      );
      eventInsert.run(r.owner, r.repo, num, hoursAgo(opened), "issue.first_seen", null);
      eventInsert.run(r.owner, r.repo, num, hoursAgo(lastActionH), `issue.${actionKind}`, null);
      if (actionCount > 1) {
        eventInsert.run(r.owner, r.repo, num, hoursAgo(Math.max(1, lastActionH - 2)), "issue.chat", null);
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
