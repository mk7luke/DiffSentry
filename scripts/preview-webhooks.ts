/**
 * Stand up the SPA + API in open mode with seeded webhook deliveries for a
 * visual check of the /webhooks command-center screen.
 * Run: PORT=8092 npx tsx scripts/preview-webhooks.ts
 *
 * Open mode (no OAuth) → the local operator is admin, so the admin-gated
 * deliveries endpoints are reachable. A fake replay closure makes the Replay
 * button work without a real GitHub App.
 */
import express from "express";
import path from "node:path";
import os from "node:os";

async function main() {
  const tmpDb = path.join(os.tmpdir(), `ds-preview-webhooks-${Date.now()}.db`);
  process.env.DB_PATH = tmpDb;

  const { openDatabase } = await import("../src/storage/db.js");
  const { createApiRouter } = await import("../src/api/router.js");
  const { recordRepo, recordWebhookDelivery } = await import("../src/storage/dao.js");
  const { dispatchWebhookEvent, extractWebhookMeta } = await import("../src/webhook/dispatch.js");

  const db = openDatabase();
  if (!db) throw new Error("failed to open db");

  recordRepo({ owner: "interact", repo: "atlas", installationId: 1 });

  const mkPr = (action: string, number: number) => ({
    action,
    pull_request: { number },
    repository: { name: "atlas", owner: { login: "interact" } },
    installation: { id: 1 },
    sender: { login: "alice" },
  });
  const mkIssue = (number: number) => ({
    action: "opened",
    issue: { number, title: "Flaky retry on /api/sync", user: { login: "bob", type: "User" } },
    repository: { name: "atlas", owner: { login: "interact" } },
    installation: { id: 1 },
  });
  const mkComment = (number: number) => ({
    action: "created",
    comment: { id: 9001, body: "@diffsentry please re-review", user: { login: "carol", type: "User" } },
    issue: { number, pull_request: {} },
    repository: { name: "atlas", owner: { login: "interact" } },
    installation: { id: 1 },
  });

  // A spread of deliveries: opened/synchronize/closed PRs, an issue, a comment,
  // a rejected (bad-signature) delivery, and a replay of the first.
  recordWebhookDelivery({ event: "pull_request", action: "opened", owner: "interact", repo: "atlas", number: 128, deliveryId: "d-aaa-001", signatureOk: true, payload: mkPr("opened", 128) });
  recordWebhookDelivery({ event: "pull_request", action: "synchronize", owner: "interact", repo: "atlas", number: 128, deliveryId: "d-aaa-002", signatureOk: true, payload: mkPr("synchronize", 128) });
  recordWebhookDelivery({ event: "issue_comment", action: "created", owner: "interact", repo: "atlas", number: 128, deliveryId: "d-aaa-003", signatureOk: true, payload: mkComment(128) });
  recordWebhookDelivery({ event: "issues", action: "opened", owner: "interact", repo: "atlas", number: 204, deliveryId: "d-aaa-004", signatureOk: true, payload: mkIssue(204) });
  recordWebhookDelivery({ event: "pull_request", action: "closed", owner: "interact", repo: "atlas", number: 127, deliveryId: "d-aaa-005", signatureOk: true, payload: mkPr("closed", 127) });
  recordWebhookDelivery({ event: "ping", action: null, owner: "interact", repo: "atlas", number: null, deliveryId: "d-aaa-006", signatureOk: false, payload: { zen: "Non-blocking is better than blocking.", hook_id: 42 } });
  const firstId = recordWebhookDelivery({ event: "pull_request", action: "opened", owner: "interact", repo: "atlas", number: 128, deliveryId: "d-aaa-007", signatureOk: true, payload: mkPr("opened", 128), replayedFrom: 1 });
  void firstId;

  const replayWebhook = async ({ event, payload, replayedFrom }: { event: string; payload: unknown; replayedFrom: number }) => {
    const meta = extractWebhookMeta(payload);
    const newDeliveryId = recordWebhookDelivery({ event, action: meta.action, owner: meta.owner, repo: meta.repo, number: meta.number, signatureOk: true, payload, replayedFrom });
    // No real reviewer in preview — just resolve the route shape.
    const fake = {
      handlePullRequest: () => Promise.resolve(),
      autoResolveOnPush: () => Promise.resolve(),
      handlePRClose: () => {},
      handleIssueOpened: () => Promise.resolve(),
      handleComment: () => Promise.resolve(),
      handleIssueComment: () => Promise.resolve(),
      getInstallationOctokit: () => Promise.reject(new Error("preview")),
    };
    const { status } = await dispatchWebhookEvent({ reviewer: fake as any, botName: "diffsentry" }, event, payload);
    return { newDeliveryId, status };
  };

  const webDist = path.resolve(__dirname, "..", "web", "dist");
  const learningsDir = path.join(os.tmpdir(), `ds-preview-webhooks-learnings-${Date.now()}`);

  const app = express();
  app.use("/api/v1", createApiRouter({ learningsDir, replayWebhook }));
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => err && next());
  });

  const port = Number.parseInt(process.env.PORT ?? "8092", 10);
  app.listen(port, () => {
    console.log(`\n  DiffSentry SPA preview → http://localhost:${port}/webhooks\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
