import type { Request, Response, Router } from "express";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import {
  createApiToken,
  insertAuditLog,
  listApiTokens,
  revokeApiToken,
  type ApiTokenRow,
} from "../storage/dao.js";
import { bus } from "../realtime/bus.js";
import { API_SCOPES, generateApiToken, normalizeScopes } from "./token-auth.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// API token administration — create / list / revoke. All admin-only and cookie
// session only: requireRole('admin') resolves a token principal to at most
// `author`, so a bearer token can never reach these endpoints. Each mutating
// route follows the command-center write contract: requireRole + CSRF verify +
// audit_log row + a bus event (token.changed).
//
// The plaintext secret is returned exactly once, from POST /tokens. Only the
// hash is ever stored, so it cannot be retrieved again.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenRouteDeps {
  /** requireRole factory bound to the router's actor resolver. */
  requireRole: (role: Role) => import("express").RequestHandler;
  /** CSRF runtime (cookie sessions). Token principals are exempt but never
   *  reach here anyway — these routes are admin/cookie-only. */
  csrf: CsrfRuntime;
}

type ErrorCode = "forbidden" | "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseScopes(scopesJson: string | null): string[] {
  if (!scopesJson) return [];
  try {
    const parsed = JSON.parse(scopesJson);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Public-facing token metadata — never includes the hash. */
function toMeta(r: ApiTokenRow) {
  return {
    id: r.id,
    name: r.name,
    scopes: parseScopes(r.scopes_json),
    created_by: r.created_by,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  };
}

export function registerTokenRoutes(router: Router, deps: TokenRouteDeps): void {
  const admin = deps.requireRole("admin");

  // ── List (admin) ────────────────────────────────────────────────────
  router.get("/tokens", admin, (_req: Request, res: Response) => {
    try {
      sendData(res, { tokens: listApiTokens().map(toMeta), availableScopes: [...API_SCOPES] });
    } catch (err) {
      logger.error({ err }, "api GET /tokens failed");
      sendError(res, 500, "internal", "Failed to list tokens.");
    }
  });

  // ── Create (admin) → returns the plaintext secret ONCE ──────────────
  router.post("/tokens", admin, deps.csrf.verify, (req: Request, res: Response) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) {
      sendError(res, 400, "bad_request", "A non-empty 'name' is required.");
      return;
    }
    const scopes = normalizeScopes(body.scopes);
    try {
      const { token, hash } = generateApiToken();
      const id = createApiToken({ name, tokenHash: hash, scopes, createdBy: actor?.login ?? null });
      if (id == null) {
        sendError(res, 500, "internal", "Failed to create token — persistence is disabled.");
        return;
      }
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: "token.create",
        targetType: "api_token",
        targetRef: String(id),
        payload: { name, scopes },
        result: "ok",
      });
      bus.publish("token.changed", {
        id,
        name,
        action: "create",
        actor: actor?.login ?? null,
        role: actor?.role ?? null,
        result: "ok",
      });
      // The plaintext `token` is present only in this response.
      sendData(res, { id, name, scopes, token }, 201);
    } catch (err) {
      logger.error({ err }, "api POST /tokens failed");
      sendError(res, 500, "internal", "Failed to create token.");
    }
  });

  // ── Revoke (admin) ──────────────────────────────────────────────────
  // Type the params so req.params.id is `string` regardless of Express's
  // default generics (mirrors PrParams in actions.ts).
  router.delete("/tokens/:id", admin, deps.csrf.verify, (req: Request<{ id: string }>, res: Response) => {
    const actor = getActor(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      sendError(res, 400, "bad_request", "Invalid token id.");
      return;
    }
    try {
      const revoked = revokeApiToken(id);
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: "token.revoke",
        targetType: "api_token",
        targetRef: String(id),
        result: revoked ? "ok" : "noop",
      });
      bus.publish("token.changed", {
        id,
        name: null,
        action: "revoke",
        actor: actor?.login ?? null,
        role: actor?.role ?? null,
        result: revoked ? "ok" : "noop",
      });
      sendData(res, { id, revoked });
    } catch (err) {
      logger.error({ err, id }, "api DELETE /tokens/:id failed");
      sendError(res, 500, "internal", "Failed to revoke token.");
    }
  });
}
