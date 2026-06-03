import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import { insertAuditLog } from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { logger } from "../logger.js";
import {
  getWebhookDeliveries,
  getWebhookDelivery,
  getWebhookEventTypes,
  getWebhookRepos,
} from "../dashboard/queries.js";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook deliveries — capture inspection + replay.
//
// Raw deliveries are persisted by the /webhook handler (src/server.ts) into the
// webhook_deliveries table. These endpoints expose them read-only and let an
// admin re-dispatch a stored payload through the same engine path.
//
// All three are admin-gated: raw payloads carry installation ids and private
// repo content, so they are as sensitive as the audit log. Replay additionally
// requires the CSRF token, writes an audit_log row, and emits a bus event.
// ─────────────────────────────────────────────────────────────────────────────

/** Records a new (flagged) delivery + re-dispatches the stored payload. Provided
 *  by server.ts (it owns the Reviewer + dispatch path). */
export type ReplayWebhook = (opts: {
  event: string;
  payload: unknown;
  replayedFrom: number;
}) => Promise<{ newDeliveryId: number | null; status: number }>;

export interface WebhookRouteDeps {
  /** requireRole factory bound to the router's actor resolver. */
  requireRole: (role: Role) => import("express").RequestHandler;
  csrf: CsrfRuntime;
  /** When omitted, replay returns 503 (the GET inspection endpoints still work). */
  replayWebhook?: ReplayWebhook;
}

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Register the webhook-delivery endpoints on the API router (under /api/v1). */
export function registerWebhookRoutes(router: Router, deps: WebhookRouteDeps): void {
  const admin = deps.requireRole("admin");

  // ── GET /webhooks — list + filter (event, repo) ────────────────────
  router.get("/webhooks", admin, (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const str = (k: string) => {
        const v = q[k];
        return typeof v === "string" && v.length > 0 ? v : undefined;
      };
      const num = (k: string, dflt: number) => {
        const v = q[k];
        if (typeof v !== "string") return dflt;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : dflt;
      };
      const { rows, total } = getWebhookDeliveries({
        event: str("event"),
        repo: str("repo"),
        limit: num("limit", 100),
        offset: num("offset", 0),
      });
      sendData(res, { rows, total, events: getWebhookEventTypes(), repos: getWebhookRepos() });
    } catch (err) {
      logger.error({ err }, "api /webhooks failed");
      sendError(res, 500, "internal", "Failed to load webhook deliveries.");
    }
  });

  // ── GET /webhooks/:id — full stored payload ────────────────────────
  router.get("/webhooks/:id", admin, (req: Request<{ id: string }>, res) => {
    const id = parseId(req.params.id);
    if (id == null) {
      sendError(res, 400, "bad_request", "Invalid delivery id.");
      return;
    }
    try {
      const row = getWebhookDelivery(id);
      if (!row) {
        sendError(res, 404, "not_found", `No delivery #${id}.`);
        return;
      }
      sendData(res, row);
    } catch (err) {
      logger.error({ err, id }, "api /webhooks/:id failed");
      sendError(res, 500, "internal", "Failed to load delivery.");
    }
  });

  // ── POST /webhooks/:id/replay — re-dispatch (admin + CSRF) ─────────
  router.post(
    "/webhooks/:id/replay",
    admin,
    deps.csrf.verify,
    async (req: Request<{ id: string }>, res: Response) => {
      const actor = getActor(req);
      const id = parseId(req.params.id);
      if (id == null) {
        sendError(res, 400, "bad_request", "Invalid delivery id.");
        return;
      }
      if (!deps.replayWebhook) {
        sendError(res, 503, "internal", "Replay is unavailable (no reviewer wired in).");
        return;
      }

      let row;
      try {
        row = getWebhookDelivery(id);
      } catch (err) {
        logger.error({ err, id }, "api replay: failed to load delivery");
        sendError(res, 500, "internal", "Failed to load delivery.");
        return;
      }
      if (!row) {
        sendError(res, 404, "not_found", `No delivery #${id}.`);
        return;
      }
      if (!row.event) {
        sendError(res, 400, "bad_request", "Delivery has no event type to replay.");
        return;
      }
      if (!row.payload_json) {
        sendError(res, 400, "bad_request", "Delivery has no stored payload to replay.");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        sendError(res, 400, "bad_request", "Stored payload is not valid JSON.");
        return;
      }

      try {
        const { newDeliveryId, status } = await deps.replayWebhook({
          event: row.event,
          payload,
          replayedFrom: id,
        });
        insertAuditLog({
          actorLogin: actor?.login ?? null,
          actorRole: actor?.role ?? null,
          action: "webhook.replay",
          targetType: "webhook_delivery",
          targetRef: String(id),
          payload: { event: row.event, action: row.action, newDeliveryId, dispatchStatus: status },
          result: "ok",
        });
        bus.publish("webhook.replayed", {
          id,
          newDeliveryId,
          event: row.event,
          action: row.action,
          actor: actor?.login ?? null,
        });
        sendData(res, { id, newDeliveryId, event: row.event, dispatchStatus: status, result: "replayed" }, 202);
      } catch (err) {
        logger.error({ err, id }, "webhook replay failed");
        insertAuditLog({
          actorLogin: actor?.login ?? null,
          actorRole: actor?.role ?? null,
          action: "webhook.replay",
          targetType: "webhook_delivery",
          targetRef: String(id),
          result: "error",
        });
        sendError(res, 500, "internal", "Replay failed.");
      }
    },
  );
}
