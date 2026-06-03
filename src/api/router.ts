import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { getRecentLogs, logger } from "../logger.js";
import { LearningsStore } from "../learnings.js";
import type { Learning } from "../types.js";
import type { AuthRuntime } from "../dashboard/auth.js";
import {
  getApprovalMix,
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
}

type ErrorCode =
  | "unauthorized"
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
  void new LearningsStore(deps.learningsDir); // reserved for future write endpoints (W0.3)

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

  // ─── /me ───────────────────────────────────────────────────────────
  // RBAC arrives in W0.3 — every authenticated user is 'admin' for now.
  router.get("/me", (req, res) => {
    const u = (req as Request & { dsUser?: { login: string; id: number } }).dsUser ?? null;
    const user = u
      ? { login: u.login, id: u.id, role: "admin" as const }
      : { login: "local", id: 0, role: "admin" as const };
    sendData(res, { user, authEnabled: !!deps.auth });
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

  // ─── /patterns ─────────────────────────────────────────────────────
  router.get("/patterns", (_req, res) => {
    try {
      sendData(res, { rules: getPatternRules(200) });
    } catch (err) {
      logger.error({ err }, "api /patterns failed");
      sendError(res, 500, "internal", "Failed to load patterns.");
    }
  });

  // Unknown /api/v1/* path → JSON 404 (so the SPA fallback never serves HTML here).
  router.use((_req, res) => {
    sendError(res, 404, "not_found", "Unknown API endpoint.");
  });

  return router;
}
