import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { getRecentLogs, logger } from "../logger.js";
import { LearningsStore } from "../learnings.js";
import type { Learning } from "../types.js";
import { createNoopCsrf, type AuthRuntime, type CsrfRuntime } from "../dashboard/auth.js";
import {
  capabilitiesFor,
  createRequireRole,
  isRole,
  loadRoleConfigFromEnv,
  resolveActor,
  getActor,
  type RoleConfig,
} from "../dashboard/roles.js";
import { insertAuditLog, setRole } from "../storage/dao.js";
import { registerStreamRoute } from "./stream.js";
import { registerActionRoutes, type ReviewerActions } from "./actions.js";
import {
  getActivity,
  getActivityKinds,
  getApprovalMix,
  getAuditActions,
  getAuditLog,
  getDailyActivity,
  getEvents,
  getFindingsForPR,
  getHealthCounts,
  getHotPaths,
  getInstallationId,
  getPR,
  getPRReviews,
  getPatternRules,
  getRecentIssues,
  getRecentPRsWithReviews,
  getRepoOverview,
  getRoleOverrides,
  getSparkline,
  getTopRules,
  queryFindings,
  queryFingerprintGroups,
  repoExists,
  type FindingFilters,
} from "../dashboard/queries.js";

// ─────────────────────────────────────────────────────────────────────────────
// API surface — JSON-only, read-only mirror of the server-rendered dashboard.
//
// Standard envelope: success → { data }, failure → { error: { code, message } }.
// Every handler degrades gracefully when persistence is disabled (the query
// layer already returns empty results when openDatabase() is null), so the API
// never throws just because the DB is off.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiDeps {
  learningsDir: string;
  /** Returns an octokit scoped to an installation. Optional — config omitted when null. */
  getInstallationOctokit?: (installationId: number) => Promise<import("@octokit/rest").Octokit>;
  /** OAuth runtime. When present, every endpoint requires a valid session. */
  auth?: AuthRuntime | null;
  /** Env-derived role allowlists. Defaults to loadRoleConfigFromEnv(). */
  roleConfig?: RoleConfig;
  /** Reviewer action surface. When omitted, the command (write) endpoints and
   * the SSE stream are still mounted, but actions have nothing to drive — so
   * they are only registered when a reviewer is provided. */
  reviewer?: ReviewerActions;
}

type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "internal";

function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}

function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const configCache = new Map<string, { yaml: string | null; ts: number }>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function loadRepoConfigSafe(deps: ApiDeps, owner: string, repo: string): Promise<string | null> {
  const key = `${owner}/${repo}`;
  const now = Date.now();
  const cached = configCache.get(key);
  if (cached && now - cached.ts < CONFIG_TTL_MS) return cached.yaml;
  if (!deps.getInstallationOctokit) return null;
  const id = getInstallationId(owner, repo);
  if (id == null) return null;
  try {
    const octokit = await deps.getInstallationOctokit(id);
    const { data } = await octokit.repos.getContent({ owner, repo, path: ".diffsentry.yaml" });
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      configCache.set(key, { yaml: null, ts: now });
      return null;
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    configCache.set(key, { yaml: content, ts: now });
    return content;
  } catch (err) {
    logger.debug({ err, owner, repo }, "api: failed to fetch .diffsentry.yaml");
    configCache.set(key, { yaml: null, ts: now });
    return null;
  }
}

async function loadLearningsSafe(baseDir: string, owner: string, repo: string): Promise<Learning[]> {
  try {
    const fp = path.join(baseDir, owner, `${repo}.json`);
    const raw = await fs.readFile(fp, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Learning[];
  } catch {
    return [];
  }
}

function parseFindingFilters(q: Record<string, unknown>): FindingFilters {
  const str = (k: string) => {
    const v = q[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const num = (k: string) => {
    const v = q[k];
    if (typeof v !== "string") return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    severity: str("severity"),
    source: str("source"),
    repo: str("repo"),
    q: str("q"),
    fingerprint: str("fingerprint"),
    ageDays: num("age") ?? undefined,
    limit: num("limit") ?? 100,
    offset: num("offset") ?? 0,
  };
}

export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  void new LearningsStore(deps.learningsDir); // reserved for future write endpoints

  const authEnabled = !!deps.auth;
  const roleConfig = deps.roleConfig ?? loadRoleConfigFromEnv();
  // CSRF verify is bound to the session secret when auth is on; in open mode
  // (no OAuth) there is no session to bind against, so writes pass freely.
  const csrf: CsrfRuntime = deps.auth ? deps.auth.csrf : createNoopCsrf();
  const requireRole = createRequireRole((req) => resolveActor(req, roleConfig, authEnabled));

  // Parse JSON bodies for write endpoints. Scoped to /api/v1 only — the raw
  // webhook body parser on /webhook is mounted separately and untouched.
  router.use(express.json({ limit: "1mb" }));

  // Auth gate — JSON 401 instead of the HTML-redirect the dashboard uses.
  // `req.path` here is relative to the /api/v1 mount.
  router.use((req, res, next) => {
    if (!deps.auth) return next();
    const user = deps.auth.authenticate(req);
    if (!user) {
      sendError(res, 401, "unauthorized", "Authentication required.");
      return;
    }
    (req as Request & { dsUser?: { login: string; id: number } }).dsUser = user;
    next();
  });

  // ─── /stream (SSE) ─────────────────────────────────────────────────
  // Mounted behind the auth gate above; any authenticated role may subscribe.
  registerStreamRoute(router);

  // ─── Command actions (write, author+) ──────────────────────────────
  // Only when a reviewer is wired in (server.ts). The full write contract —
  // requireRole + CSRF + audit_log + bus event — lives in registerActionRoutes.
  if (deps.reviewer) {
    registerActionRoutes(router, { reviewer: deps.reviewer, requireRole, csrf });
  }

  // ─── /me ───────────────────────────────────────────────────────────
  // The role resolves from the roles table > admin env > author env > viewer
  // floor; capabilities are the client-side mirror the SPA gates controls on.
  // In open mode (no OAuth) the local operator is treated as admin.
  router.get("/me", (req, res) => {
    const actor = resolveActor(req, roleConfig, authEnabled);
    sendData(res, {
      user: {
        login: actor.login,
        id: actor.id,
        role: actor.role,
        capabilities: actor.capabilities,
      },
      authEnabled,
    });
  });

  // ─── /health ───────────────────────────────────────────────────────
  router.get("/health", (_req, res) => {
    try {
      const counts = getHealthCounts();
      const logs = getRecentLogs(100);
      sendData(res, { counts, logs });
    } catch (err) {
      logger.error({ err }, "api /health failed");
      sendError(res, 500, "internal", "Failed to load health.");
    }
  });

  // ─── /repos ────────────────────────────────────────────────────────
  router.get("/repos", (_req, res) => {
    try {
      const repos = getRepoOverview();
      const activity = getDailyActivity(null, null, 14);
      sendData(res, { repos, activity });
    } catch (err) {
      logger.error({ err }, "api /repos failed");
      sendError(res, 500, "internal", "Failed to load repos.");
    }
  });

  // ─── /repos/:owner/:repo ───────────────────────────────────────────
  router.get("/repos/:owner/:repo", async (req, res) => {
    const { owner, repo } = req.params;
    try {
      if (!repoExists(owner, repo)) {
        sendError(res, 404, "not_found", `No data for ${owner}/${repo}.`);
        return;
      }
      const [learnings, config] = await Promise.all([
        loadLearningsSafe(deps.learningsDir, owner, repo),
        loadRepoConfigSafe(deps, owner, repo),
      ]);
      sendData(res, {
        owner,
        repo,
        sparkline: getSparkline(owner, repo),
        hotPaths: getHotPaths(owner, repo),
        topRules: getTopRules(owner, repo),
        prs: getRecentPRsWithReviews(owner, repo, 50),
        issues: getRecentIssues(owner, repo, 50),
        activity: getDailyActivity(owner, repo, 30),
        approvalMix: getApprovalMix(owner, repo, 30),
        learnings,
        config,
      });
    } catch (err) {
      logger.error({ err, owner, repo }, "api repo detail failed");
      sendError(res, 500, "internal", "Failed to load repo detail.");
    }
  });

  // ─── /repos/:owner/:repo/prs/:number ───────────────────────────────
  router.get("/repos/:owner/:repo/prs/:number", (req, res) => {
    const { owner, repo } = req.params;
    const number = Number.parseInt(req.params.number, 10);
    if (!Number.isFinite(number) || number <= 0) {
      sendError(res, 400, "bad_request", "Invalid PR number.");
      return;
    }
    try {
      const pr = getPR(owner, repo, number);
      const reviews = getPRReviews(owner, repo, number);
      if (!pr && reviews.length === 0) {
        sendError(res, 404, "not_found", `No data for ${owner}/${repo}#${number}.`);
        return;
      }
      sendData(res, {
        owner,
        repo,
        number,
        pr,
        reviews,
        latest: reviews[0] ?? null,
        findings: getFindingsForPR(owner, repo, number),
        events: getEvents(owner, repo, number, 200),
      });
    } catch (err) {
      logger.error({ err, owner, repo, number }, "api PR detail failed");
      sendError(res, 500, "internal", "Failed to load PR detail.");
    }
  });

  // ─── /findings ─────────────────────────────────────────────────────
  router.get("/findings", (req, res) => {
    try {
      const filters = parseFindingFilters(req.query as Record<string, unknown>);
      const { rows, total } = queryFindings(filters);
      const groups = queryFingerprintGroups(filters, 20);
      sendData(res, { rows, total, groups, filters });
    } catch (err) {
      logger.error({ err }, "api /findings failed");
      sendError(res, 500, "internal", "Failed to load findings.");
    }
  });

  // ─── /activity ─────────────────────────────────────────────────────
  // The Ops Console backfill: a unified, newest-first feed of events + reviews.
  // Page older by passing ?before=<nextBefore> — an opaque cursor returned by
  // the previous response (a bare ISO timestamp is also accepted, legacy). Any
  // authenticated role may read it — the live tail is the SSE /stream above.
  router.get("/activity", (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const str = (k: string) => {
        const v = q[k];
        return typeof v === "string" && v.length > 0 ? v : undefined;
      };
      const num = (k: string) => {
        const v = q[k];
        // Digit-only: reject partially-numeric junk like "10abc" so it falls
        // back to the default rather than silently parsing to 10.
        if (typeof v !== "string" || !/^\d+$/.test(v)) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const result = getActivity({
        repo: str("repo"),
        kind: str("kind"),
        severity: str("severity"),
        before: str("before"),
        limit: num("limit") ?? 100,
      });
      sendData(res, { ...result, kinds: getActivityKinds() });
    } catch (err) {
      logger.error({ err }, "api /activity failed");
      sendError(res, 500, "internal", "Failed to load activity.");
    }
  });

  // ─── /patterns ─────────────────────────────────────────────────────
  router.get("/patterns", (_req, res) => {
    try {
      sendData(res, { rules: getPatternRules(200) });
    } catch (err) {
      logger.error({ err }, "api /patterns failed");
      sendError(res, 500, "internal", "Failed to load patterns.");
    }
  });

  // ─── /audit (admin) ─────────────────────────────────────────────────
  // Read the audit trail + current role overrides. Admin-gated: a viewer or
  // author gets a 403 here (and the SPA hides the screen for them entirely).
  router.get("/audit", requireRole("admin"), (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const num = (k: string, dflt: number) => {
        const v = q[k];
        if (typeof v !== "string") return dflt;
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : dflt;
      };
      const str = (k: string) => {
        const v = q[k];
        return typeof v === "string" && v.length > 0 ? v : undefined;
      };
      const { rows, total } = getAuditLog({
        limit: num("limit", 100),
        offset: num("offset", 0),
        action: str("action"),
        actor: str("actor"),
      });
      sendData(res, { rows, total, actions: getAuditActions(), roles: getRoleOverrides() });
    } catch (err) {
      logger.error({ err }, "api /audit failed");
      sendError(res, 500, "internal", "Failed to load audit log.");
    }
  });

  // ─── /roles (admin write) ───────────────────────────────────────────
  // Grant or clear a per-login role override. Demonstrates the full write
  // contract: requireRole('admin') + CSRF (X-CSRF-Token header) + audit_log.
  router.post("/roles", requireRole("admin"), csrf.verify, (req, res) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const login = typeof body.login === "string" ? body.login.trim() : "";
    // `role` may be a valid role to set, or null/"" to clear the override.
    const rawRole = body.role;
    const clearing = rawRole == null || rawRole === "";
    if (!login) {
      sendError(res, 400, "bad_request", "A non-empty 'login' is required.");
      return;
    }
    if (!clearing && !isRole(rawRole)) {
      sendError(res, 400, "bad_request", "'role' must be one of viewer, author, admin (or null to clear).");
      return;
    }
    try {
      const role = clearing ? null : (rawRole as string);
      setRole({ login, role, grantedBy: actor?.login ?? null });
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: clearing ? "role.clear" : "role.set",
        targetType: "login",
        targetRef: login.toLowerCase(),
        payload: { role },
        result: "ok",
      });
      sendData(res, { login: login.toLowerCase(), role: clearing ? null : role });
    } catch (err) {
      logger.error({ err, login }, "api POST /roles failed");
      sendError(res, 500, "internal", "Failed to update role.");
    }
  });

  // Unknown /api/v1/* path → JSON 404 (so the SPA fallback never serves HTML here).
  router.use((_req, res) => {
    sendError(res, 404, "not_found", "Unknown API endpoint.");
  });

  return router;
}
