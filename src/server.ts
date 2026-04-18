import express from "express";
import { Webhooks } from "@octokit/webhooks";
import { Config } from "./types.js";
import { Reviewer } from "./reviewer.js";
import { logger } from "./logger.js";

export function createServer(config: Config) {
  const app = express();
  const webhooks = new Webhooks({ secret: config.githubWebhookSecret });
  const reviewer = new Reviewer(config);

  // Parse raw body for webhook signature verification
  app.use("/webhook", express.raw({ type: "application/json" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      provider: config.aiProvider,
      botName: config.botName,
    });
  });

  // Webhook endpoint
  app.post("/webhook", async (req, res) => {
    const signature = req.headers["x-hub-signature-256"] as string;
    const event = req.headers["x-github-event"] as string;
    const body = req.body as Buffer;

    if (!signature || !event) {
      res.status(400).json({ error: "Missing headers" });
      return;
    }

    try {
      await webhooks.verify(body.toString(), signature);
    } catch {
      logger.warn("Webhook signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const payload = JSON.parse(body.toString());

    // ─── Pull Request Events ─────────────────────────────────
    if (event === "pull_request") {
      const action = payload.action;
      const { number } = payload.pull_request;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const installationId = payload.installation?.id;

      if (!installationId) {
        logger.warn("No installation ID in webhook payload");
        res.status(400).json({ error: "No installation ID" });
        return;
      }

      if (action === "opened") {
        logger.info({ owner, repo, pr: number, action }, "PR opened, queuing full review");
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }

      if (action === "synchronize") {
        logger.info({ owner, repo, pr: number, action }, "PR updated, queuing incremental review");
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number, "incremental").catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }

      // closed — abort in-flight reviews
      if (action === "closed") {
        logger.info({ owner, repo, pr: number, action }, "PR closed, aborting any in-flight review");
        reviewer.handlePRClose(owner, repo, number);
        res.status(200).json({ status: "ok" });
        return;
      }

      // ready_for_review — draft PR became ready
      if (action === "ready_for_review") {
        logger.info({ owner, repo, pr: number, action }, "PR ready for review, queuing full review");
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }
    }

    // ─── Issue Comment Events (Chat Commands) ────────────────
    if (event === "issue_comment" && payload.action === "created") {
      const comment = payload.comment;
      const issue = payload.issue;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const installationId = payload.installation?.id;

      // Only process comments on pull requests (issues with pull_request field)
      if (!issue.pull_request || !installationId) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      const pullNumber = issue.number;
      const commentBody = comment.body || "";
      const commentId = comment.id;

      // Ignore comments authored by bots (including ourselves) — prevents
      // recursive self-triggering when our own walkthrough/tips text mentions
      // the bot name.
      if (comment.user?.type === "Bot") {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Check if our bot is mentioned
      if (!commentBody.toLowerCase().includes(`@${config.botName.toLowerCase()}`)) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      logger.info(
        { owner, repo, pr: pullNumber, commentId },
        "Bot mentioned in PR comment, processing command"
      );
      res.status(202).json({ status: "accepted" });

      reviewer
        .handleComment(installationId, owner, repo, pullNumber, commentBody, commentId)
        .catch((err) => {
          logger.error({ err, owner, repo, pr: pullNumber }, "Background comment handling failed");
        });
      return;
    }

    // ─── PR Review Comment Events (Reply to threads) ─────────
    if (event === "pull_request_review_comment" && payload.action === "created") {
      const comment = payload.comment;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = payload.pull_request.number;
      const installationId = payload.installation?.id;
      const commentBody = comment.body || "";
      const commentId = comment.id;

      if (!installationId) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      if (comment.user?.type === "Bot") {
        res.status(200).json({ status: "ignored" });
        return;
      }

      if (!commentBody.toLowerCase().includes(`@${config.botName.toLowerCase()}`)) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      logger.info(
        { owner, repo, pr: pullNumber, commentId },
        "Bot mentioned in review comment, processing"
      );
      res.status(202).json({ status: "accepted" });

      reviewer
        .handleComment(installationId, owner, repo, pullNumber, commentBody, commentId)
        .catch((err) => {
          logger.error({ err, owner, repo, pr: pullNumber }, "Background review comment handling failed");
        });
      return;
    }

    res.status(200).json({ status: "ignored" });
  });

  return app;
}
