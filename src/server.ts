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
    res.json({ status: "ok", provider: config.aiProvider });
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

    // Only handle PR opened and synchronized (new push) events
    if (event === "pull_request") {
      const action = payload.action;
      if (action === "opened" || action === "synchronize") {
        const { number } = payload.pull_request;
        const owner = payload.repository.owner.login;
        const repo = payload.repository.name;
        const installationId = payload.installation?.id;

        if (!installationId) {
          logger.warn("No installation ID in webhook payload");
          res.status(400).json({ error: "No installation ID" });
          return;
        }

        logger.info(
          { owner, repo, pr: number, action },
          "PR event received, queuing review"
        );

        // Respond immediately, process async
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number).catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }
    }

    res.status(200).json({ status: "ignored" });
  });

  return app;
}
