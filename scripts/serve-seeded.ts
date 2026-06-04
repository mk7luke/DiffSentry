/**
 * Dev-only: serve the built SPA + API against a temp SQLite seeded with sample
 * rows, so the Cmd-K palette can be exercised in a real browser. Open mode
 * (no OAuth) → local operator is admin, so role-gated actions show.
 *
 *   ENABLE_DASHBOARD=1 npx tsx scripts/serve-seeded.ts [port]
 */
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const port = Number.parseInt(process.argv[2] ?? "5179", 10);
  const tmpDb = path.join(os.tmpdir(), `ds-serve-seeded-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open temp db");
  const now = new Date().toISOString();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?,?,?,?,?)`).run("mk7luke", "diffsentry-sandbox", 1, hoursAgo(240), now);
  db.prepare(`INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen) VALUES (?,?,?,?,?)`).run("mk7luke", "payments-api", 1, hoursAgo(500), hoursAgo(48));
  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run("mk7luke", "diffsentry-sandbox", 42, "Add rate limiter to the auth gateway", "alice", "open", "aaaaaaa", "bbbbbbb", hoursAgo(10));
  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run("mk7luke", "payments-api", 7, "Refactor charge retry logic", "bob", "open", "ccccccc", "ddddddd", hoursAgo(30));

  const r1 = db.prepare(`INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("mk7luke", "diffsentry-sandbox", 42, "bbbbbbb", "chill", "request_changes", "Two critical findings on the rate limiter.", 82, "critical", 6, 0, 0, hoursAgo(9)).lastInsertRowid;
  const insertFinding = db.prepare(`INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertFinding.run(r1, "src/limiter.ts", 42, "issue", "critical", "Race condition on the shared counter", "Concurrent access is unsynchronized.", "fp1", "ai", "high");
  insertFinding.run(r1, "src/limiter.ts", 88, "issue", "major", "Missing null check on token", "token may be null.", "fp2", "ai", "medium");

  const learningsDir = path.join(os.tmpdir(), `ds-serve-learnings-${Date.now()}`);
  fs.mkdirSync(path.join(learningsDir, "mk7luke"), { recursive: true });
  fs.writeFileSync(path.join(learningsDir, "mk7luke", "diffsentry-sandbox.json"), JSON.stringify([{ id: "l1", repo: "mk7luke/diffsentry-sandbox", content: "Prefer async/await over raw promise chains in this repo.", createdAt: hoursAgo(240) }]));

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, reviewer: fakeReviewer() }));
  const webDist = path.join(__dirname, "..", "web", "dist");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });
  app.listen(port, () => console.log(`seeded SPA on http://127.0.0.1:${port}`));
}

function fakeReviewer() {
  const noop = async () => {};
  return {
    triggerReview: noop,
    resolveThreads: noop,
    pauseReviews: () => {},
    resumeReviews: () => {},
    cancelReview: () => {},
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
