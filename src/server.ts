import express from "express";
import path from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { Config } from "./types.js";
import { Reviewer } from "./reviewer.js";
import { logger } from "./logger.js";
import { recordEvent } from "./storage/dao.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { createApiRouter } from "./api/router.js";
import { createAuth, loadAuthConfigFromEnv } from "./dashboard/auth.js";
import { applyPersistedSettings, isPauseAll, isAutoReviewEnabled } from "./settings/overrides.js";

/**
 * Whether an automatic (webhook-triggered) review should be queued for a repo,
 * or a reason it's blocked. The global Pause-All kill switch wins, then the
 * per-repo auto-review toggle. Both are operator settings persisted in
 * settings_overrides and no-op (return "allowed") when persistence is off.
 */
function reviewQueueBlockedReason(owner: string, repo: string): "paused" | "auto_review_disabled" | null {
  if (isPauseAll()) return "paused";
  if (!isAutoReviewEnabled(owner, repo)) return "auto_review_disabled";
  return null;
}

export function createServer(config: Config) {
  const app = express();
  const webhooks = new Webhooks({ secret: config.githubWebhookSecret });
  const reviewer = new Reviewer(config);

  // Apply any persisted runtime settings (e.g. log level) on boot so a value
  // set via the dashboard survives restarts. No-ops when persistence is off.
  applyPersistedSettings();

  // Parse raw body for webhook signature verification
  app.use("/webhook", express.raw({ type: "application/json" }));

  // Read-only dashboard (SQLite-backed — see docs/PRD-web-dashboard.md).
  // Gated off by default: the dashboard currently has no auth, so it must be
  // opted into explicitly with ENABLE_DASHBOARD=1. Auth lands in PRD step 6.
  // Static SPA assets live next to the compiled server. At runtime __dirname is
  // the build's dist/ dir, so the SPA build output sits at ../web/dist (both
  // locally after `npm run build` and in the Docker runtime image).
  const webDist = path.join(__dirname, "..", "web", "dist");

  if (process.env.ENABLE_DASHBOARD === "1") {
    const authCfg = loadAuthConfigFromEnv();
    const auth = createAuth(authCfg);

    // Legacy server-rendered dashboard — kept during the SPA transition. A
    // later cleanup PR removes src/dashboard/*.ts once the SPA reaches parity.
    app.use(
      "/dashboard",
      createDashboardRouter({
        learningsDir: config.learningsDir,
        getInstallationOctokit: (id) => reviewer.getInstallationOctokit(id),
        auth,
      }),
    );

    // New JSON API consumed by the Vite SPA. The reviewer is exposed as a
    // narrow action surface (mirroring getInstallationOctokit) so the command
    // endpoints can trigger reviews, resolve threads, and pause/resume/cancel.
    app.use(
      "/api/v1",
      createApiRouter({
        learningsDir: config.learningsDir,
        getInstallationOctokit: (id) => reviewer.getInstallationOctokit(id),
        auth,
        reviewer: {
          triggerReview: (installationId, owner, repo, number, mode) =>
            reviewer.triggerReview(installationId, owner, repo, number, mode),
          resolveThreads: (installationId, owner, repo, number) =>
            reviewer.resolveThreads(installationId, owner, repo, number),
          pauseReviews: (owner, repo, number) => reviewer.pauseReviews(owner, repo, number),
          resumeReviews: (owner, repo, number) => reviewer.resumeReviews(owner, repo, number),
          cancelReview: (owner, repo, number) => reviewer.cancelReview(owner, repo, number),
        },
      }),
    );

    // Serve built SPA assets (index.html, /assets/*). express.static only
    // matches files that exist, so it never shadows /webhook, /health, /api,
    // or /dashboard — those fall through to their handlers. Client-side routes
    // are handled by the index.html fallback at the end of createServer.
    app.use(express.static(webDist));

    logger.info(
      { authEnabled: !!auth, orgs: authCfg?.allowedOrgs ?? [] },
      "Dashboard + API mounted (ENABLE_DASHBOARD=1): SPA at /, API at /api/v1, legacy dashboard at /dashboard",
    );
    if (!auth) {
      logger.warn(
        "Dashboard is mounted WITHOUT OAuth. Set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, DASHBOARD_ALLOWED_ORGS, DASHBOARD_URL to enable auth.",
      );
    }
  }

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

    // Persistent event log (best-effort; no-op when DB disabled).
    try {
      const owner = payload.repository?.owner?.login;
      const repo = payload.repository?.name;
      const number =
        payload.pull_request?.number ?? payload.issue?.number ?? null;
      if (owner && repo) {
        recordEvent({ owner, repo, number, kind: `${event}.${payload.action ?? ""}`.replace(/\.$/, "") });
      }
    } catch {
      // best effort
    }

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
        const blocked = reviewQueueBlockedReason(owner, repo);
        if (blocked) {
          logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing full review (operator control)");
          res.status(200).json({ status: blocked });
          return;
        }
        logger.info({ owner, repo, pr: number, action }, "PR opened, queuing full review");
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }

      if (action === "synchronize") {
        logger.info({ owner, repo, pr: number, action }, "PR updated");
        res.status(202).json({ status: "accepted" });

        // Run push-driven auto-resolve unconditionally (not gated by pause/draft/auto-review),
        // so threads close even on PRs the bot won't re-review.
        reviewer.autoResolveOnPush(installationId, owner, repo, number).catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Push auto-resolve failed");
        });

        // Gate only the re-review queue behind the operator controls — the
        // auto-resolve above still runs so addressed threads close.
        const blocked = reviewQueueBlockedReason(owner, repo);
        if (blocked) {
          logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing incremental review (operator control)");
          return;
        }

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
        const blocked = reviewQueueBlockedReason(owner, repo);
        if (blocked) {
          logger.info({ owner, repo, pr: number, action, blocked }, "Not queuing review (operator control)");
          res.status(200).json({ status: blocked });
          return;
        }
        logger.info({ owner, repo, pr: number, action }, "PR ready for review, queuing full review");
        res.status(202).json({ status: "accepted" });

        reviewer.handlePullRequest(installationId, owner, repo, number, "full").catch((err) => {
          logger.error({ err, owner, repo, pr: number }, "Background review failed");
        });
        return;
      }
    }

    // ─── Issue Events (auto-summary on opened) ───────────────
    if (event === "issues") {
      const action = payload.action;
      const issue = payload.issue;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const installationId = payload.installation?.id;

      if (!installationId || !issue) {
        res.status(400).json({ error: "No installation/issue" });
        return;
      }

      // Skip PR-shaped issue events (GitHub fires `issues` on PRs in some
      // edge cases; the `pull_request` field disambiguates).
      if (issue.pull_request) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Bot-authored issues never get an auto-summary; avoids loops.
      if (issue.user?.type === "Bot") {
        res.status(200).json({ status: "ignored" });
        return;
      }

      if (action === "opened" || action === "reopened") {
        logger.info({ owner, repo, issue: issue.number, action }, "Issue opened, queuing auto-summary");
        res.status(202).json({ status: "accepted" });

        reviewer
          .handleIssueOpened(installationId, owner, repo, issue.number)
          .catch((err) => {
            logger.error({ err, owner, repo, issue: issue.number }, "Background issue summary failed");
          });
        return;
      }

      // Other issue actions (edited, labeled, closed, assigned, ...) are
      // ignored for now — keep the surface tight, avoid noisy comments.
      res.status(200).json({ status: "ignored" });
      return;
    }

    // ─── Issue Comment Edited (Finishing Touches checkbox) ───
    if (event === "issue_comment" && payload.action === "edited") {
      const comment = payload.comment;
      const issue = payload.issue;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const installationId = payload.installation?.id;
      if (!issue.pull_request || !installationId) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      const body: string = comment.body || "";
      const prevBody: string = payload.changes?.body?.from || "";
      // Only act on our own walkthrough comments (which carry the marker).
      if (!body.includes("<!-- DiffSentry Walkthrough -->")) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      const triggers = [
        { label: "Create PR with unit tests", action: "generate_tests" as const },
        { label: "Push docstring commit to this branch", action: "generate_docstrings" as const },
        { label: "Push simplification commit to this branch", action: "simplify" as const },
        { label: "Push autofix commit to this branch", action: "autofix" as const },
      ];
      const newlyChecked: typeof triggers = [];
      for (const t of triggers) {
        const checkedNow = new RegExp(`-\\s*\\[x\\][^\\n]*${t.label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`).test(body);
        const checkedBefore = new RegExp(`-\\s*\\[x\\][^\\n]*${t.label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`).test(prevBody);
        if (checkedNow && !checkedBefore) newlyChecked.push(t);
      }

      if (newlyChecked.length === 0) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      logger.info({ owner, repo, pr: issue.number, actions: newlyChecked.map((t) => t.action) }, "Finishing touches checkbox triggered");
      res.status(202).json({ status: "accepted", actions: newlyChecked.map((t) => t.action) });

      const commentId = comment.id;
      for (const t of newlyChecked) {
        const fakeBody = `@${config.botName} ${t.action.replace(/_/g, " ")}`;
        reviewer
          .handleComment(installationId, owner, repo, issue.number, fakeBody, commentId)
          .catch((err) => logger.error({ err, action: t.action }, "Finishing touches dispatch failed"));
      }
      return;
    }

    // ─── Issue Comment Events (Chat Commands) ────────────────
    if (event === "issue_comment" && payload.action === "created") {
      const comment = payload.comment;
      const issue = payload.issue;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const installationId = payload.installation?.id;

      if (!installationId) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      const issueOrPRNumber = issue.number;
      const commentBody = comment.body || "";
      const commentId = comment.id;

      // Ignore comments authored by bots (including ourselves) — prevents
      // recursive self-triggering when our own walkthrough/tips text mentions
      // the bot name.
      if (comment.user?.type === "Bot") {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Check if our bot is mentioned. The mention check is the same on PRs
      // and issues — only what we do next differs.
      if (!commentBody.toLowerCase().includes(`@${config.botName.toLowerCase()}`)) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // Comment on a PR → existing PR comment handler.
      if (issue.pull_request) {
        logger.info(
          { owner, repo, pr: issueOrPRNumber, commentId },
          "Bot mentioned in PR comment, processing command",
        );
        res.status(202).json({ status: "accepted" });

        reviewer
          .handleComment(installationId, owner, repo, issueOrPRNumber, commentBody, commentId)
          .catch((err) => {
            logger.error({ err, owner, repo, pr: issueOrPRNumber }, "Background comment handling failed");
          });
        return;
      }

      // Comment on an actual issue → new issue handler.
      logger.info(
        { owner, repo, issue: issueOrPRNumber, commentId },
        "Bot mentioned in issue comment, processing command",
      );
      res.status(202).json({ status: "accepted" });

      reviewer
        .handleIssueComment(installationId, owner, repo, issueOrPRNumber, commentBody, commentId)
        .catch((err) => {
          logger.error({ err, owner, repo, issue: issueOrPRNumber }, "Background issue comment handling failed");
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

      // Treat any reply on a thread our bot started as an implicit @mention
      // — mirrors CodeRabbit. Detected via in_reply_to_id on the comment
      // and a lookup of the parent comment's author through the installation
      // Octokit (works on private repos, respects auth + rate limits).
      let isImplicitReply = false;
      const replyToId = comment.in_reply_to_id;
      if (replyToId) {
        try {
          const octokit = await reviewer.getInstallationOctokit(installationId);
          const parent = await octokit.pulls.getReviewComment({
            owner,
            repo,
            comment_id: replyToId,
          });
          const parentLogin = (parent.data.user?.login ?? "").toLowerCase();
          if (
            parent.data.user?.type === "Bot" &&
            parentLogin.includes(config.botName.toLowerCase())
          ) {
            isImplicitReply = true;
          }
        } catch (err) {
          logger.debug({ err, replyToId }, "Failed to fetch parent review comment");
        }
      }

      const isMention = commentBody.toLowerCase().includes(`@${config.botName.toLowerCase()}`);
      if (!isMention && !isImplicitReply) {
        res.status(200).json({ status: "ignored" });
        return;
      }

      // For implicit replies, prepend the mention so parseCommand routes
      // free-form text to the chat handler instead of returning null.
      const dispatchBody = isImplicitReply && !isMention
        ? `@${config.botName} ${commentBody}`
        : commentBody;

      logger.info(
        { owner, repo, pr: pullNumber, commentId, implicit: isImplicitReply },
        "Processing review-thread comment",
      );
      res.status(202).json({ status: "accepted", implicit: isImplicitReply });

      reviewer
        .handleComment(installationId, owner, repo, pullNumber, dispatchBody, commentId, "review_thread")
        .catch((err) => {
          logger.error({ err, owner, repo, pr: pullNumber }, "Background review comment handling failed");
        });
      return;
    }

    res.status(200).json({ status: "ignored" });
  });

  // SPA client-side routing fallback. Registered LAST so it never shadows the
  // webhook, health check, API, legacy dashboard, or static assets. Any other
  // GET returns the SPA shell; the React router takes over from there.
  if (process.env.ENABLE_DASHBOARD === "1") {
    app.get("*", (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/webhook") ||
        req.path.startsWith("/dashboard") ||
        req.path === "/health"
      ) {
        return next();
      }
      res.sendFile(path.join(webDist, "index.html"), (err) => {
        if (err) next();
      });
    });
  }

  return app;
}
