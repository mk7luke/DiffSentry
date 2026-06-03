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

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal" | "unavailable";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseId(raw: string): number | null {
  // Strict: the whole segment must be digits, so "123abc" is rejected (400)
  // rather than silently truncated to delivery 123 by parseInt.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Register the webhook-delivery endpoints on the API router (under /api/v1). */
export function registerWebhookRoutes(router: Router, deps: WebhookRouteDeps): void {
  const admin = deps.requireRole("admin");

  // ── GET /webhooks — list + filter (event, repo) ────────────────────
  router.get("/webhooks", admin, (req, res) => {
    const q = req.query as Record<string, unknown>;
    const str = (k: string) => {
      const v = q[k];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    // Strict, non-negative decimal-integer parsing for pagination (matches the
    // :id parser): an absent value uses the default; a malformed/negative value
    // is a 400 rather than being silently clamped, so bad client state surfaces.
    const count = (k: string, dflt: number): number | null => {
      const v = q[k];
      if (v === undefined) return dflt;
      if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : null;
    };
    const limit = count("limit", 100);
    const offset = count("offset", 0);
    // limit must be a positive, bounded page size (matches the query layer's
    // 1..500 clamp); offset must be non-negative. limit=0 / huge values are 400.
    if (limit == null || offset == null || limit < 1 || limit > 500) {
      sendError(res, 400, "bad_request", "'limit' must be an integer between 1 and 500, and 'offset' must be a non-negative integer.");
      return;
    }
    // A repo filter must be a full "owner/repo" slug (exactly two non-empty
    // segments); a typo like "?repo=acme" is rejected instead of silently
    // dropping the filter and broadening the result to every repo.
    const repo = str("repo");
    if (repo !== undefined && !/^[^/]+\/[^/]+$/.test(repo)) {
      sendError(res, 400, "bad_request", "'repo' must be a full 'owner/repo' slug.");
      return;
    }
    try {
      const { rows, total } = getWebhookDeliveries({ event: str("event"), repo, limit, offset });
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
        sendError(res, 503, "unavailable", "Replay is unavailable (no reviewer wired in).");
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
      // Never promote a rejected (or unverified) delivery into a trusted replay:
      // its body never passed signature verification, so re-dispatching it would
      // run an unauthenticated payload through the engine as an admin action.
      if (row.signature_ok !== 1) {
        sendError(res, 400, "bad_request", "Rejected deliveries cannot be replayed.");
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
