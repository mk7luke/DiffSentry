/**
 * Stand up the SPA + API (open/admin mode) with seeded data for visual review
 * of the operator-settings UI. Run: PORT=8092 npx tsx scripts/preview-spa.ts
 * Requires `npm run build:web` first so web/dist exists.
 */
import express from "express";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-preview-spa-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");

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
  const rv = db.prepare(
    `INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level, files_processed, files_skipped_similar, files_skipped_trivial, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  db.prepare(`INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("interact", "atlas", 101, "Add rate limiter", "alice", "open", "b", "h", hoursAgo(3));
  rv.run("interact", "atlas", 101, "sha101", "chill", "comment", "## Summary\n\nLooks fine.", 42, "elevated", 5, 1, 0, hoursAgo(2));

  // Seed a per-repo override so the repo card shows a non-default state.
  const { upsertSettingOverride } = await import("../src/storage/dao.js");
  upsertSettingOverride({ scope: "interact/atlas", key: "profile", value: "assertive", updatedBy: "local" });

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir: path.join(os.tmpdir(), "ds-preview-spa-learnings") }));
  const webDist = path.join(__dirname, "..", "web", "dist");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });

  const port = Number.parseInt(process.env.PORT ?? "8092", 10);
  app.listen(port, () => console.log(`\n  SPA preview (open/admin): http://localhost:${port}/settings\n`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
