/**
 * Stand up a populated, open-mode (admin) instance of the API + built SPA on a
 * temp SQLite DB so the W1.A3 action bar can be screenshotted. No GitHub App
 * config needed: open mode treats the operator as admin, so every write button
 * renders. Run: npx tsx scripts/screenshot-actionbar.ts  (server stays up).
 */
import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-shot-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.ENABLE_DASHBOARD = "1";

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { recordRepo, recordPR, recordReview, recordFindings, recordEvent } = await import("../src/storage/dao.js");

  if (!openDatabase()) throw new Error("failed to open temp db");

  const ctx = {
    owner: "acme",
    repo: "web",
    pullNumber: 142,
    title: "Add streaming export pipeline for large report downloads",
    description: "Streams CSV exports instead of buffering them in memory.",
    baseBranch: "main",
    baseSha: "aaaa111",
    headBranch: "feat/streaming-export",
    headSha: "bbbb222cccc333",
    files: [],
    author: "rivka",
  };
  recordRepo({ owner: ctx.owner, repo: ctx.repo, installationId: 99 });
  recordPR(ctx, { state: "open" });
  const reviewId = recordReview({
    ctx,
    result: {
      summary:
        "## Summary\n\nThis PR replaces the in-memory export buffer with a streaming pipeline. Risk is moderate — the new backpressure path needs a test under slow consumers.",
      comments: [],
      approval: "REQUEST_CHANGES",
    },
    risk: { score: 58, level: "medium" } as never,
    profile: "assertive",
    filesProcessed: 7,
    filesSkippedSimilar: 1,
    filesSkippedTrivial: 2,
  });
  if (reviewId) {
    recordFindings(reviewId, [
      { path: "src/export/stream.ts", line: 88, side: "RIGHT", severity: "major" as never, title: "Unbounded queue under slow consumers", body: "If the consumer stalls, the producer keeps reading rows into memory — the backpressure check is bypassed when `highWaterMark` is 0." },
      { path: "src/export/stream.ts", line: 121, side: "RIGHT", severity: "minor" as never, title: "Missing flush on early return", body: "The early `return` on an empty result set skips `res.end()`, leaving the response open." },
      { path: "src/api/report.ts", line: 44, side: "RIGHT", severity: "nit" as never, title: "Prefer const", body: "`let mime` is never reassigned." },
    ]);
  }
  recordEvent({ owner: ctx.owner, repo: ctx.repo, number: ctx.pullNumber, kind: "pull_request.opened" });
  recordEvent({ owner: ctx.owner, repo: ctx.repo, number: ctx.pullNumber, kind: "pull_request.synchronize" });

  const learningsDir = path.join(os.tmpdir(), `ds-shot-learnings-${Date.now()}`);
  fs.mkdirSync(learningsDir, { recursive: true });

  const app = express();
  // Open mode: no auth runtime → resolveActor() treats the caller as admin, so
  // the write buttons render. A no-op reviewer surface satisfies the action
  // routes (we only need them mounted so /me + the SPA render the bar).
  const noop = () => Promise.resolve();
  app.use(
    "/api/v1",
    createApiRouter({
      learningsDir,
      reviewer: {
        triggerReview: noop,
        resolveThreads: noop,
        pauseReviews: () => {},
        resumeReviews: () => {},
        cancelReview: () => {},
        runCommand: noop,
      },
    }),
  );
  const webDist = path.join(__dirname, "..", "web", "dist");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const prUrl = `http://localhost:${port}/repos/${ctx.owner}/${ctx.repo}/pr/${ctx.pullNumber}`;
  const repoUrl = `http://localhost:${port}/repos/${ctx.owner}/${ctx.repo}`;
  console.log(`READY port=${port}`);
  console.log(`PR_URL=${prUrl}`);
  console.log(`REPO_URL=${repoUrl}`);
  // Keep the process alive for the screenshotter; Ctrl-C to stop.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
