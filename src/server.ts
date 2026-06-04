import express from "express";
import path from "node:path";
import { Config } from "./types.js";
import { Reviewer } from "./reviewer.js";
import { logger } from "./logger.js";
import { recordWebhookDelivery } from "./storage/dao.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { createApiRouter } from "./api/router.js";
import { createAuth, loadAuthConfigFromEnv } from "./dashboard/auth.js";
import { applyPersistedSettings } from "./settings/overrides.js";
import { dispatchWebhookEvent, extractWebhookMeta } from "./webhook/dispatch.js";
import { verifyWebhookSignature } from "./webhook/signature.js";

export function createServer(config: Config) {
  const app = express();
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
          runCommand: (installationId, owner, repo, number, command) =>
            reviewer.runCommand(installationId, owner, repo, number, command),
        },
        // Admin replay: persist a NEW delivery row (flagged replayed_from) and
        // re-run the stored payload through the same dispatch path. Marked
        // signature_ok=true because the operator — not GitHub — is the source.
        replayWebhook: async ({ event, payload, replayedFrom }) => {
          const meta = extractWebhookMeta(payload);
          const newDeliveryId = recordWebhookDelivery({
            event,
            action: meta.action,
            owner: meta.owner,
            repo: meta.repo,
            number: meta.number,
            signatureOk: true,
            payload,
            replayedFrom,
          });
          const { status } = await dispatchWebhookEvent({ reviewer, botName: config.botName }, event, payload);
          return { newDeliveryId, status };
        },
        // First-run diagnostics: the AI reachability probe + the GitHub App
        // introspection both run through the reviewer (which owns the provider
        // and the App-authed Octokit).
        diagnostics: {
          aiTarget: () => reviewer.aiTarget(),
          testAiProvider: () => reviewer.testAiProvider(),
          getGithubDiagnostics: () => reviewer.getGithubDiagnostics(),
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
    const deliveryId = (req.headers["x-github-delivery"] as string) || null;
    const body = req.body as Buffer;

    if (!signature || !event) {
      res.status(400).json({ error: "Missing headers" });
      return;
    }

    const signatureOk = verifyWebhookSignature(config.githubWebhookSecret, body.toString(), signature);

    // Parse defensively: a rejected (bad-signature) delivery may still be JSON,
    // and we record it anyway so the deliveries view surfaces rejected hits too.
    let payload: any = null;
    // What we persist: the parsed payload on success, or the raw UTF-8 body
    // wrapped on parse failure — so a malformed delivery is still inspectable
    // rather than stored as a bare `null`.
    let payloadForStorage: unknown = null;
    try {
      payload = JSON.parse(body.toString());
      payloadForStorage = payload;
    } catch {
      payload = null;
      payloadForStorage = { raw: body.toString("utf8") };
    }

    // Capture the raw delivery BEFORE dispatch (best-effort; no-op when DB
    // disabled), including rejected ones, so the inspection view sees everything.
    try {
      const meta = payload != null ? extractWebhookMeta(payload) : { action: null, owner: null, repo: null, number: null };
      recordWebhookDelivery({
        event,
        action: meta.action,
        owner: meta.owner,
        repo: meta.repo,
        number: meta.number,
        deliveryId,
        signatureOk,
        payload: payloadForStorage,
      });
    } catch {
      // best effort
    }

    if (!signatureOk) {
      logger.warn("Webhook signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    if (!payload) {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    const { status, body: responseBody } = await dispatchWebhookEvent(
      { reviewer, botName: config.botName },
      event,
      payload,
    );
    res.status(status).json(responseBody);
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
