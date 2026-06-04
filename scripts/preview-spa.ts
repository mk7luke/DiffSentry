/**
 * Serve the built SPA (web/dist) + JSON API with seeded data for visual review.
 * Open mode (no OAuth) → local admin, so the Branding admin form, operator
 * settings, and the Audit screen are all visible.
 *
 * Build first: npm run build:web   (so web/dist exists)
 * Run:         PORT=8092 npx tsx scripts/preview-spa.ts
 */
import express from "express";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-preview-spa-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { upsertSettingOverride } = await import("../src/storage/dao.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open db");

  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  const repos = [
    { owner: "interact", repo: "atlas", h: 2 },
    { owner: "mk7luke", repo: "diffsentry-sandbox", h: 1 },
    { owner: "corp", repo: "old-service", h: 1200 },
  ];
  for (const r of repos) {
    db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`)
      .run(r.owner, r.repo, 1, daysAgo(60), hoursAgo(r.h));
  }

  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("interact", "atlas", 128, "Add rate limiter", "alice", "open", "aaaaaaa", "bbbbbbb", hoursAgo(10));
  const rv = db.prepare(
    `INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("interact", "atlas", 128, "bbbbbbb", "assertive", "request_changes", "## Summary\n\nTwo critical findings on the limiter.", 82, "critical", 6, 0, 0, hoursAgo(9)).lastInsertRowid as number;
  const f = db.prepare(`INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  f.run(rv, "src/limiter.ts", 42, "issue", "critical", "Race condition", "Concurrent counter access is unsynchronized.", "fp1", "ai", "high");
  f.run(rv, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");
  f.run(rv, "src/auth.ts", 5, "security", "minor", "Weak default", "Use a stronger default.", "fp3", "safety", "medium");
  db.prepare(`INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?,?,?,?,?,?)`).run("interact", "atlas", "no-console", "builtin", "fpx", rv);
  db.prepare(`INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?,?,?,?,?,?)`).run("interact", "atlas", 128, hoursAgo(10), "pull_request.opened", null);

  // Seed a per-repo override so the operator-settings repo card shows a non-default state.
  upsertSettingOverride({ scope: "interact/atlas", key: "profile", value: "assertive", updatedBy: "local" });

  const webDist = path.join(__dirname, "..", "web", "dist");
  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir: path.join(os.tmpdir(), "ds-preview-spa-learnings") }));
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });

  const port = Number.parseInt(process.env.PORT ?? "8092", 10);
  app.listen(port, () => console.log(`\n  SPA preview (open/admin): http://localhost:${port}/  (db: ${tmpDb})\n`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
