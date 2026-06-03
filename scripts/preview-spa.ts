/**
 * Serve the built SPA (web/dist) + JSON API with seeded data for visual review
 * of the theme system. Open mode (no OAuth) → local admin, so the Branding
 * admin form + Audit screen are visible.
 *
 * Build first: (cd web && npm run build)
 * Run:        PORT=8092 npx tsx scripts/preview-spa.ts
 */
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-preview-spa-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const db = openDatabase();
  if (!db) throw new Error("failed to open db");

  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`)
    .run("interact", "atlas", 1, hoursAgo(1440), hoursAgo(2));
  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("interact", "atlas", 128, "Add rate limiter", "alice", "open", "aaaaaaa", "bbbbbbb", hoursAgo(10));
  const rv = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("interact", "atlas", 128, "bbbbbbb", "assertive", "request_changes", "## Summary\n\nTwo critical findings on the limiter.", 82, "critical", 6, 0, 0, hoursAgo(9)).lastInsertRowid as number;
  const f = db.prepare(`INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  f.run(rv, "src/limiter.ts", 42, "issue", "critical", "Race condition", "Concurrent counter access is unsynchronized.", "fp1", "ai", "high");
  f.run(rv, "src/limiter.ts", 88, "issue", "major", "Missing null check", "token may be null.", "fp2", "ai", "medium");
  f.run(rv, "src/auth.ts", 5, "security", "minor", "Weak default", "Use a stronger default.", "fp3", "safety", "medium");
  db.prepare(`INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?,?,?,?,?,?)`).run("interact", "atlas", "no-console", "builtin", "fpx", rv);
  db.prepare(`INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?,?,?,?,?,?)`).run("interact", "atlas", 128, hoursAgo(10), "pull_request.opened", null);

  const { createApiRouter } = await import("../src/api/router.js");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.join(here, "..", "web", "dist");
  const learningsDir = path.join(os.tmpdir(), `ds-preview-spa-learnings-${Date.now()}`);

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir }));
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  const port = Number.parseInt(process.env.PORT ?? "8092", 10);
  app.listen(port, () => {
    console.log(`SPA preview at http://localhost:${port}/  (db: ${tmpDb})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
