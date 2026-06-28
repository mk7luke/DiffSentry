import express from "express";
import type { Request, Response, Router } from "express";
import crypto from "node:crypto";
import type { Role } from "../dashboard/roles.js";
import { getActor } from "../dashboard/roles.js";
import type { CsrfRuntime } from "../dashboard/auth.js";
import {
  createImpactShare,
  listImpactShares,
  revokeImpactShare,
  findActiveImpactShareByHash,
  touchImpactShareViewed,
  insertAuditLog,
  type ImpactShareRow,
} from "../storage/dao.js";
import { getImpact } from "../dashboard/queries.js";
import type { ImpactReport } from "../dashboard/queries.js";
import { parseImpactRange, canonicalRangeKey, impactMinutesPerFinding } from "./impact-range.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shareable Impact reports — turn the aggregate Impact report into a public,
// revocable artifact.
//
// A share is a high-entropy, prefixed, URL-safe token embedded in a link. Only
// its SHA-256 hash is persisted (mirroring api_tokens); the plaintext is shown
// once at creation. The public read endpoint hashes the presented token, looks
// up the ACTIVE row, and serves `getImpact` scoped to the share's fixed `repo`
// (a viewer can change the date range but never widen the repo scope).
//
// SAFETY: the public surface returns ONLY the aggregate ImpactReport — review /
// finding counts, severity splits, time bins, and the time-saved heuristic. It
// carries no source code, no per-finding messages, and no PR-level detail, so a
// share leaks nothing beyond rolled-up impact numbers.
// ─────────────────────────────────────────────────────────────────────────────

/** Share token prefix — recognizable + greppable (it is NOT secret on its own). */
export const SHARE_TOKEN_PREFIX = "dss_";

/** SHA-256 hex of the share token — what we persist and look up by. */
export function hashShareToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Mint a new share token: a prefixed, 240-bit, URL-safe string and its hash. */
export function generateShareToken(): { token: string; hash: string } {
  const token = SHARE_TOKEN_PREFIX + crypto.randomBytes(30).toString("base64url");
  return { token, hash: hashShareToken(token) };
}

/**
 * Build the absolute, public-facing URL for a freshly minted share token. Honors
 * an explicit PUBLIC_BASE_URL / DASHBOARD_URL when set (correct behind a proxy /
 * custom domain); otherwise reconstructs the origin from the request, preferring
 * the X-Forwarded-* headers a reverse proxy sets.
 */
export function buildSharePublicUrl(req: Request, token: string): string {
  const path = `/share/impact/${encodeURIComponent(token)}`;
  const configured = process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL;
  if (configured) return configured.replace(/\/+$/, "") + path;
  const fwdProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const fwdHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const proto = fwdProto || req.protocol || "http";
  const host = fwdHost || req.get("host") || "localhost";
  return `${proto}://${host}${path}`;
}

/**
 * Resolve a share token + requested range into its aggregate ImpactReport, or
 * null when the token is unknown, revoked, or persistence is off (the caller
 * answers 404). The repo scope is taken from the stored share — never from the
 * request — so a public viewer can only re-window time, not widen scope. Best-
 * effort stamps last_viewed_at.
 */
export function buildSharedImpactReport(token: string, rangeRaw: unknown): { report: ImpactReport } | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const share = findActiveImpactShareByHash(hashShareToken(token));
  if (!share) return null;
  touchImpactShareViewed(share.id);
  // Default to the share's stored range when the viewer hasn't picked one.
  const range = parseImpactRange(
    typeof rangeRaw === "string" && rangeRaw.length > 0 ? rangeRaw : share.default_range ?? undefined,
  );
  const report = getImpact({
    days: range.days,
    label: range.label,
    repo: share.repo,
    minutesPerFinding: impactMinutesPerFinding(),
  });
  return { report };
}

// ─── Envelope helpers (match the JSON API: { data } / { error }) ─────────────

type ErrorCode = "not_found" | "bad_request" | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** The public read handler, shared by the in-router and standalone mounts. */
function handlePublicShareRead(req: Request, res: Response): void {
  try {
    const id = (req.params as { id?: string }).id ?? "";
    const result = buildSharedImpactReport(id, (req.query as Record<string, unknown>).range);
    if (!result) {
      sendError(res, 404, "not_found", "This share link is invalid or has been revoked.");
      return;
    }
    sendData(res, result.report);
  } catch (err) {
    logger.error({ err }, "public impact share read failed");
    sendError(res, 500, "internal", "Failed to load the shared impact report.");
  }
}

/**
 * Register the public, no-auth read route on an existing router (mounted at
 * /api/v1): GET /public/impact/:id. Call this BEFORE the auth gate.
 */
export function registerPublicShareReadRoute(router: Router): void {
  router.get("/public/impact/:id", handlePublicShareRead);
}

/**
 * A standalone router exposing only the public read route, for mounting at
 * /api/v1/public in server.ts so a share link resolves even when the full
 * authed API (ENABLE_DASHBOARD) is not mounted.
 */
export function createPublicShareRouter(): Router {
  const router = express.Router();
  router.get("/impact/:id", handlePublicShareRead);
  return router;
}

// ─── Admin management (create / list / revoke) ───────────────────────────────

export interface ShareRouteDeps {
  /** requireRole factory bound to the router's actor resolver. */
  requireRole: (role: Role) => import("express").RequestHandler;
  /** CSRF runtime (cookie sessions). Token principals never reach here — these
   *  routes are admin/cookie-only. */
  csrf: CsrfRuntime;
}

/** Public-facing share metadata — never includes the hash or the token. */
function toShareMeta(r: ImpactShareRow) {
  return {
    id: r.id,
    label: r.label,
    repo: r.repo,
    range: r.default_range,
    created_by: r.created_by,
    created_at: r.created_at,
    last_viewed_at: r.last_viewed_at,
    revoked_at: r.revoked_at,
  };
}

/**
 * Mount the admin share-management routes. All admin-only + cookie-session only
 * (requireRole('admin') resolves a token principal to ≤ author, so a bearer
 * token can never mint or revoke a public link). Each mutating route follows the
 * write contract: requireRole + CSRF verify + audit_log row.
 *
 * The plaintext share token is returned exactly once, from POST. Only its hash
 * is stored, so the link cannot be reconstructed afterward — revoke and re-mint
 * if it is lost.
 */
export function registerShareRoutes(router: Router, deps: ShareRouteDeps): void {
  const admin = deps.requireRole("admin");

  // ── List (admin) ────────────────────────────────────────────────────
  router.get("/impact/shares", admin, (_req: Request, res: Response) => {
    try {
      sendData(res, { shares: listImpactShares().map(toShareMeta) });
    } catch (err) {
      logger.error({ err }, "api GET /impact/shares failed");
      sendError(res, 500, "internal", "Failed to list shares.");
    }
  });

  // ── Create (admin) → returns the share URL + plaintext token ONCE ────
  router.post("/impact/shares", admin, deps.csrf.verify, (req: Request, res: Response) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repo = typeof body.repo === "string" && body.repo.includes("/") ? body.repo : null;
    const range = canonicalRangeKey(body.range);
    const label = typeof body.label === "string" && body.label.trim().length > 0 ? body.label.trim().slice(0, 120) : null;
    try {
      const { token, hash } = generateShareToken();
      const id = createImpactShare({ shareHash: hash, label, repo, defaultRange: range, createdBy: actor?.login ?? null });
      if (id == null) {
        sendError(res, 503, "internal", "Failed to create share — persistence is disabled.");
        return;
      }
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: "impact_share.create",
        targetType: "impact_share",
        targetRef: String(id),
        payload: { repo, range, label },
        result: "ok",
      });
      const url = buildSharePublicUrl(req, token);
      // The plaintext `token` + full `url` are present only in this response.
      sendData(res, { id, label, repo, range, token, url, path: `/share/impact/${token}` }, 201);
    } catch (err) {
      logger.error({ err }, "api POST /impact/shares failed");
      sendError(res, 500, "internal", "Failed to create share.");
    }
  });

  // ── Revoke (admin) ──────────────────────────────────────────────────
  router.delete("/impact/shares/:id", admin, deps.csrf.verify, (req: Request<{ id: string }>, res: Response) => {
    const actor = getActor(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      sendError(res, 400, "bad_request", "Invalid share id.");
      return;
    }
    try {
      const revoked = revokeImpactShare(id);
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: "impact_share.revoke",
        targetType: "impact_share",
        targetRef: String(id),
        result: revoked ? "ok" : "noop",
      });
      sendData(res, { id, revoked });
    } catch (err) {
      logger.error({ err, id }, "api DELETE /impact/shares/:id failed");
      sendError(res, 500, "internal", "Failed to revoke share.");
    }
  });
}
