import type { Request, RequestHandler, Response } from "express";
import { getRole, VALID_ROLES, type Role } from "../storage/dao.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Role-based access control for the command-center API.
//
// Roles (lowest → highest privilege): viewer < author < admin.
//
// A login's role is resolved with this precedence (first match wins):
//   1. roles table override  (per-login, set via the admin UI / DAO)   — W0.1
//   2. DASHBOARD_ADMIN_LOGINS env allowlist                            → admin
//   3. DASHBOARD_AUTHOR_LOGINS env allowlist                           → author
//   4. authenticated at all (passed the viewer allowlist in auth.ts)   → viewer
//   5. otherwise denied — handled upstream by the auth gate (401), not here
//
// By the time RBAC runs the user has already cleared OAuth + the viewer
// allowlist (DASHBOARD_ALLOWED_LOGINS / DASHBOARD_ALLOWED_ORGS), so the floor
// for any authenticated request is `viewer`.
// ─────────────────────────────────────────────────────────────────────────────

export type { Role };

/** Privilege ordering — higher number outranks lower. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, author: 1, admin: 2 };

/** Capability flags the SPA reads to hide/disable controls a role can't use.
 * The server still enforces each one independently (requireRole) — this is the
 * client-side mirror, never the source of truth. */
export interface Capabilities {
  /** Read any dashboard data. Every authenticated user has this. */
  viewDashboard: boolean;
  /** Triage findings (accept/snooze/note). */
  triageFindings: boolean;
  /** Trigger reviews (full/incremental re-review of a PR). */
  triggerReview: boolean;
  /** Change per-repo / global review configuration. */
  manageConfig: boolean;
  /** Grant/revoke per-login role overrides. */
  manageRoles: boolean;
  /** Read the audit log. */
  viewAudit: boolean;
}

/** Capability matrix by role. Keep in sync with the table in the README. */
export function capabilitiesFor(role: Role): Capabilities {
  const isAuthor = role === "author" || role === "admin";
  const isAdmin = role === "admin";
  return {
    viewDashboard: true,
    triageFindings: isAuthor,
    triggerReview: isAuthor,
    manageConfig: isAdmin,
    manageRoles: isAdmin,
    viewAudit: isAdmin,
  };
}

export interface RoleConfig {
  /** Logins granted `admin` by env allowlist (lowercased). */
  adminLogins: string[];
  /** Logins granted `author` by env allowlist (lowercased). */
  authorLogins: string[];
}

function parseLoginList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Build the role config from env. Always returns a value (empty lists are
 * fine — they just mean "no env-granted authors/admins"). */
export function loadRoleConfigFromEnv(): RoleConfig {
  return {
    adminLogins: parseLoginList(process.env.DASHBOARD_ADMIN_LOGINS),
    authorLogins: parseLoginList(process.env.DASHBOARD_AUTHOR_LOGINS),
  };
}

/**
 * Resolve the role for an authenticated login. Assumes the caller has already
 * passed the viewer allowlist (so `viewer` is the floor, never "denied").
 * The roles-table override (W0.1) wins over env allowlists.
 */
export function resolveRole(login: string, cfg: RoleConfig): Role {
  const override = getRole(login); // DAO normalizes (trim + lowercase) + validates
  if (override) return override;
  const l = login.trim().toLowerCase();
  if (cfg.adminLogins.includes(l)) return "admin";
  if (cfg.authorLogins.includes(l)) return "author";
  return "viewer";
}

/** The acting user for a request, with role + capabilities resolved. */
export interface Actor {
  login: string;
  id: number;
  role: Role;
  capabilities: Capabilities;
}

interface DsUser {
  login: string;
  id: number;
}

/**
 * Resolve the acting user for a request.
 *
 * When auth is disabled (local/dev — no OAuth configured) there is no session
 * to gate on, so the local operator is treated as `admin`, matching the
 * dashboard's documented "open mode". When auth is enabled the upstream auth
 * gate has already attached `dsUser` (or answered 401), so it is present here.
 */
export function resolveActor(req: Request, cfg: RoleConfig, authEnabled: boolean): Actor {
  const u = (req as Request & { dsUser?: DsUser }).dsUser;
  if (!authEnabled || !u) {
    return { login: u?.login ?? "local", id: u?.id ?? 0, role: "admin", capabilities: capabilitiesFor("admin") };
  }
  const role = resolveRole(u.login, cfg);
  return { login: u.login, id: u.id, role, capabilities: capabilitiesFor(role) };
}

/** Reads the actor stashed on the request by `requireRole` (after it ran). */
export function getActor(req: Request): Actor | null {
  return (req as Request & { dsActor?: Actor }).dsActor ?? null;
}

/**
 * Express middleware factory: gate a route on a minimum role. Resolves the
 * actor via `resolve`, stashes it on `req.dsActor` for the handler, and answers
 * a JSON 403 (not a redirect) when the actor outranks nothing.
 */
export function createRequireRole(resolve: (req: Request) => Actor) {
  return (required: Role): RequestHandler => {
    return (req: Request, res: Response, next) => {
      const actor = resolve(req);
      (req as Request & { dsActor?: Actor }).dsActor = actor;
      if (ROLE_RANK[actor.role] >= ROLE_RANK[required]) {
        return next();
      }
      logger.warn(
        { login: actor.login, role: actor.role, required, path: req.originalUrl },
        "RBAC: forbidden — actor role outranks nothing for this route",
      );
      res.status(403).json({
        error: {
          code: "forbidden",
          message: `This action requires the '${required}' role (you are '${actor.role}').`,
        },
      });
    };
  };
}

/** True when `value` is one of the canonical roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}
