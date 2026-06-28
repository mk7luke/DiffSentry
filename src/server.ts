import express from "express";
import path from "node:path";
import { Config } from "./types.js";
import { Reviewer } from "./reviewer.js";
import { logger } from "./logger.js";
import { recordWebhookDelivery, claimWebhookDelivery, completeWebhookDelivery, releaseWebhookDelivery } from "./storage/dao.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { createApiRouter } from "./api/router.js";
import { createPublicShareRouter } from "./api/shares.js";
import { createAuth, loadAuthConfigFromEnv } from "./dashboard/auth.js";
import { applyPersistedSettings } from "./settings/overrides.js";
import { dispatchWebhookEvent, extractWebhookMeta } from "./webhook/dispatch.js";
import { verifyWebhookSignature } from "./webhook/signature.js";
import { recoverInFlightJobs } from "./realtime/jobs.js";

/**
 * What `createServer` hands back. NOTE: it intentionally returns a struct, not a
 * bare Express app — destructure it. The `recover` callback is held alongside
 * the app because it closes over the same Reviewer the routes use, so boot can
 * resume interrupted reviews without rebuilding one.
 *
 *   const { app, recover } = createServer(config);
 *   const server = app.listen(port, () => { recover(); });
 *
 * The sole production caller is src/index.ts; there are no other importers.
 */
export interface CreatedServer {
  /** The Express application — mount nothing else; call `.listen()` on it. */
  app: express.Express;
  /**
   * Re-enqueue any review jobs that were in-flight when the process last
   * stopped. Call once after the HTTP listener is up (persistence must already
   * be open). No-op (returns 0) when persistence is disabled or nothing pended.
   */
  recover: () => number;
}

export function createServer(config: Config): CreatedServer {
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

  // Public demo / sandbox mode. Enabled by default; security-conscious operators
  // can turn it off entirely with DISABLE_DEMO=1. The demo is a no-auth,
  // read-only showcase of the dashboard UI backed ENTIRELY by client-side
  // fixtures (web/src/demo). No data API is mounted for it, so the demo can
  // neither read nor mutate real data — we only serve the static SPA shell,
  // which is why it works even when ENABLE_DASHBOARD is off.
  const demoEnabled = process.env.DISABLE_DEMO !== "1";

  // Hard kill switch: when the demo is disabled, refuse /demo* outright — even
  // when the dashboard is mounted and its catch-all would otherwise serve the
  // SPA shell there. Registered first so it precedes every SPA fallback below.
  if (!demoEnabled) {
    app.get(["/demo", "/demo/*"], (_req, res) => {
      res.status(404).type("text/plain").send("Demo mode is disabled on this instance.");
    });
  }

  // Public shareable Impact report. Enabled by default; operators can turn it
  // off entirely with DISABLE_PUBLIC_SHARE=1. A tokenized share link serves the
  // read-only, AGGREGATE Impact report with NO login (revocable from the authed
  // dashboard). It is mounted independently of ENABLE_DASHBOARD so a shared link
  // keeps resolving even on a webhook-only instance:
  //   • the no-auth JSON read API at /api/v1/public/impact/:id
  //   • the SPA shell at /share/impact/:id (React renders the chrome-less view)
  // The public router is registered BEFORE the full /api/v1 router below, so it
  // takes precedence for /api/v1/public/* (and is the sole handler when the
  // dashboard is off). The /share/impact SPA fallback is registered last,
  // alongside the other SPA fallbacks.
  const shareEnabled = process.env.DISABLE_PUBLIC_SHARE !== "1";
  if (shareEnabled) {
    app.use("/api/v1/public", createPublicShareRouter());
    // Serve SPA assets (/assets/*) so the share page can boot even when neither
    // the dashboard nor the demo mounts express.static. `index: false` so this
    // never auto-serves index.html at `/` — only the explicit /share/impact
    // fallback below renders the SPA shell, leaving `/` untouched in this mode.
    // Harmless if assets are also mounted below: static only matches files that
    // exist and otherwise falls through, never shadowing /webhook, /health, or
    // the API routers.
    app.use(express.static(webDist, { index: false }));
    logger.info(
      "Public Impact sharing mounted: read API at /api/v1/public/impact/:id, viewer at /share/impact/:id. Set DISABLE_PUBLIC_SHARE=1 to disable.",
    );
  }

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
  } else if (demoEnabled) {
    // Dashboard off, demo on: mount only the static SPA assets so /demo can
    // boot. No API, no dashboard, no SPA catch-all — the only entry point is the
    // /demo fallback registered at the end of createServer. express.static only
    // matches files that exist, so it never shadows /webhook or /health.
    app.use(express.static(webDist));
    logger.info(
      "Public demo mounted: SPA shell at /demo (ENABLE_DASHBOARD off). Client-side fixtures only — no data API. Set DISABLE_DEMO=1 to disable.",
    );
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

    // Idempotency: GitHub retries deliveries (and may double-send), each carrying
    // the same X-GitHub-Delivery id. claimWebhookDelivery takes a `processing`
    // lease; only a *completed* (or fresh in-flight) delivery is treated as a
    // duplicate and short-circuited here. The lease is finalized below —
    // completed on success, released on failure — so a crash mid-dispatch leaves
    // a stale lease that a redelivery can reclaim rather than a phantom
    // duplicate. The delivery is still recorded above for the inspection view.
    // No-op (always claims) when persistence is disabled.
    // Idempotency claim. The 3-way result distinguishes a true (completed)
    // duplicate from a delivery merely in flight elsewhere, so an in-flight
    // reclaimed lease is never acknowledged as "already processed":
    //   - duplicate → 200, already processed to a terminal outcome; don't redispatch.
    //   - in_flight → 202, a concurrent run holds a fresh lease; acknowledge
    //                 receipt without re-dispatch (2xx avoids a redelivery storm;
    //                 review_jobs' per-PR supersede prevents a duplicate review).
    //   - claimed   → we own the lease; the handle is finalized below.
    let claim: import("./storage/dao.js").WebhookDeliveryClaim | null = null;
    if (deliveryId) {
      const result = claimWebhookDelivery(deliveryId);
      if (result.kind === "duplicate") {
        logger.info({ deliveryId, event }, "Duplicate webhook delivery — already completed, skipping dispatch");
        res.status(200).json({ status: "duplicate" });
        return;
      }
      if (result.kind === "in_flight") {
        logger.info({ deliveryId, event }, "Webhook delivery already in flight elsewhere — acknowledging without re-dispatch");
        res.status(202).json({ status: "in_progress" });
        return;
      }
      claim = result.claim;
    }

    try {
      const { status, body: responseBody } = await dispatchWebhookEvent(
        { reviewer, botName: config.botName },
        event,
        payload,
      );
      if (claim) {
        // Redelivery should retry only TRANSIENT failures. A 5xx (or a thrown
        // error — see catch) means we failed to process the delivery, so release
        // the lease and let GitHub redeliver. Everything else — a 2xx success OR
        // a 4xx — is a terminal, fully-processed application outcome: a 4xx
        // rejection is deterministic (an identical redelivery would just
        // re-reject, so retrying is pointless), so it's committed to `completed`
        // alongside 2xx to dedupe future redeliveries of the same id.
        if (status >= 500) {
          const released = releaseWebhookDelivery(claim);
          if (released) {
            logger.warn({ event, deliveryId, status }, "Webhook dispatch returned a server error — released delivery for redelivery");
          } else {
            // The lease wasn't ours to free (reclaimed by a newer run) or a DB
            // error: a prompt redelivery may be deduped until the lease expires.
            logger.warn({ event, deliveryId, status }, "Webhook dispatch returned a server error but the lease release did not take effect — a prompt redelivery may be deduped until the lease TTL expires");
          }
        } else {
          const completed = completeWebhookDelivery(claim);
          if (!completed) {
            // Our lease was reclaimed (dispatch outran the lease TTL) or the row
            // is gone. We keep the dispatch response rather than manufacturing a
            // 5xx: the delivery was already handled to a terminal outcome (a 2xx
            // review is dispatched durably via review_jobs; a 4xx is a final
            // rejection), so a redelivery would only duplicate or re-reject.
            // review_jobs — not this lease — is the delivery-durability
            // guarantee, so an uncommitted lease is benign (self-heals via TTL).
            logger.warn({ event, deliveryId, status }, "Webhook delivery lease completion did not take effect (lease reclaimed?); keeping the dispatch response — delivery already handled to a terminal outcome");
          }
        }
      }
      res.status(status).json(responseBody);
    } catch (err) {
      // Dispatch threw before producing a response: the work never ran, so the
      // lease above would otherwise (after it goes stale) be the only trace.
      // Release it now so a GitHub redelivery of this id is processed promptly,
      // then surface 500 so GitHub marks the delivery failed (and offers redelivery).
      if (claim) releaseWebhookDelivery(claim);
      logger.error({ err, event, deliveryId }, "Webhook dispatch failed — released delivery for redelivery");
      res.status(500).json({ error: "Dispatch failed" });
    }
  });

  // Public Impact-share SPA fallback. Registered before the dashboard/demo
  // fallbacks so the chrome-less share viewer boots in EVERY server mode — the
  // dashboard catch-all below would also serve it when ENABLE_DASHBOARD=1, but
  // this guarantees the link works on a webhook-only or demo-only instance too.
  // React Router renders the public view; the no-auth read API supplies data.
  if (shareEnabled) {
    app.get(["/share/impact", "/share/impact/*"], (_req, res, next) => {
      res.sendFile(path.join(webDist, "index.html"), (err) => {
        if (err) next();
      });
    });
  }

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
  } else if (demoEnabled) {
    // Demo SPA client-routing fallback for the dashboard-off case (when the full
    // catch-all above isn't mounted). Serves the SPA shell for /demo and its
    // sub-routes so a deep link like /demo/repos/acme/checkout-api/pr/142 boots
    // the app; React Router + the demo data layer take over from there.
    app.get(["/demo", "/demo/*"], (_req, res, next) => {
      res.sendFile(path.join(webDist, "index.html"), (err) => {
        if (err) next();
      });
    });
  }

  return {
    app,
    recover: () =>
      recoverInFlightJobs({
        handlePullRequest: (installationId, owner, repo, number, mode) =>
          reviewer.handlePullRequest(installationId, owner, repo, number, mode),
      }),
  };
}
