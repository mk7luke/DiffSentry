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
import { registerRuleRoutes } from "./rules.js";
import { reviewQueue } from "../realtime/queue.js";
import { registerWebhookRoutes, type ReplayWebhook } from "./webhooks.js";
import {
  getApprovalMix,
  getAuditActions,
  getAuditLog,
  getDailyActivity,
  getEvents,
  getFindingsForPR,
  getHealthCounts,
  getHotPaths,
  getImpact,
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
  listRepos,
  queryFindings,
  queryFingerprintGroups,
  repoExists,
  searchEntities,
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
  /** Re-dispatches a stored webhook delivery (records a flagged replay row +
   * runs the same engine path). When omitted, GET /webhooks still works but
   * POST /webhooks/:id/replay answers 503. */
  replayWebhook?: ReplayWebhook;
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

// Supported impact ranges. Bare numbers (e.g. "30") are also accepted and
// clamped to [1, 365]; "all" / "max" means all-time (no lower bound).
const IMPACT_RANGES: Record<string, { days: number | null; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
  "30d": { days: 30, label: "Last 30 days" },
  "90d": { days: 90, label: "Last 90 days" },
  "180d": { days: 180, label: "Last 180 days" },
  "365d": { days: 365, label: "Last 12 months" },
  all: { days: null, label: "All time" },
  max: { days: null, label: "All time" },
};

function parseImpactRange(raw: unknown): { days: number | null; label: string } {
  if (typeof raw !== "string" || raw.length === 0) return IMPACT_RANGES["30d"];
  const key = raw.toLowerCase();
  if (key in IMPACT_RANGES) return IMPACT_RANGES[key];
  const n = Number.parseInt(key, 10);
  if (Number.isFinite(n) && n > 0) {
    const days = Math.min(Math.max(n, 1), 365);
    return { days, label: `Last ${days} days` };
  }
  return IMPACT_RANGES["30d"];
}

/** Reviewer-minutes saved per finding heuristic, from env (default 15). */
function impactMinutesPerFinding(): number {
  const raw = process.env.IMPACT_MINUTES_PER_FINDING;
  if (!raw) return 15;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

// ─── Search ranking ─────────────────────────────────────────────────────────
// The DB returns candidate rows per entity; we score each match in one place so
// repos, PRs, findings, and (on-disk) learnings rank against the same scale.

type SearchType = "repo" | "pr" | "finding" | "learning";

interface SearchResult {
  type: SearchType;
  title: string;
  subtitle: string | null;
  /** SPA client-side route to deep-link to (note: PR route is `/pr/`, not the
   * API's `/prs/`). */
  to: string;
  owner: string;
  repo: string;
  number: number | null;
  severity: string | null;
  score: number;
}

/** Small per-type bias so equally-good text matches order sensibly (a repo name
 * hit feels more "primary" than a finding-title hit). Never dominates the
 * text-match score below. */
const TYPE_BIAS: Record<SearchType, number> = { repo: 0.3, pr: 0.25, finding: 0.2, learning: 0.15 };

/**
 * Score how well `hay` matches the lowercased query `q`. 0 means no match;
 * higher is better. Rewards prefix and word-boundary hits over mid-word ones,
 * an exact match most of all, and shorter haystacks slightly (more specific).
 */
function scoreText(hay: string | null | undefined, q: string): number {
  if (!hay) return 0;
  const h = hay.toLowerCase();
  const idx = h.indexOf(q);
  if (idx < 0) return 0;
  let s = 1;
  if (h === q) s += 3;
  else if (idx === 0) s += 2;
  else if (!/[a-z0-9]/i.test(h[idx - 1] ?? "")) s += 1; // preceded by a non-word char
  s += Math.max(0, 1 - hay.length / 120);
  return s;
}

/** Best score across several fields. */
function bestScore(q: string, ...fields: Array<string | null | undefined>): number {
  let best = 0;
  for (const f of fields) {
    const s = scoreText(f, q);
    if (s > best) best = s;
  }
  return best;
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

  // ─── Custom anti-pattern rules (admin) ─────────────────────────────
  // CRUD + a no-persist tester. Independent of the reviewer surface, so it is
  // always mounted: the same write contract (requireRole('admin') + CSRF +
  // audit_log + bus event) as the command actions above.
  registerRuleRoutes(router, { requireRole, csrf });

  // ─── Webhook deliveries (admin) ────────────────────────────────────
  // Inspection (list + full payload) and admin replay. The GET endpoints are
  // always mounted; replay only acts when a replayWebhook closure is wired in.
  registerWebhookRoutes(router, { requireRole, csrf, replayWebhook: deps.replayWebhook });

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

  // ─── /queue ──────────────────────────────────────────────────────────
  // The live review-pipeline board (queued → running → done/failed). Reads the
  // in-process registry directly, so it works regardless of persistence and is
  // available to any authenticated role (read-only, like the SSE stream). State
  // transitions arrive over /stream as `queue.updated`; this is the initial
  // snapshot a freshly-loaded board hydrates from.
  router.get("/queue", (_req, res) => {
    try {
      sendData(res, { entries: reviewQueue.snapshot() });
    } catch (err) {
      logger.error({ err }, "api /queue failed");
      sendError(res, 500, "internal", "Failed to load queue.");
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

  // ─── /impact ───────────────────────────────────────────────────────
  // The shareable impact report: headline numbers, period-over-period deltas,
  // severity trend, recurring-issue prevention, and estimated reviewer-time
  // saved. Read-only; any authenticated role may view it.
  router.get("/impact", (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const range = parseImpactRange(q.range);
      const repo = typeof q.repo === "string" && q.repo.includes("/") ? q.repo : null;
      const report = getImpact({
        days: range.days,
        label: range.label,
        repo,
        minutesPerFinding: impactMinutesPerFinding(),
      });
      sendData(res, report);
    } catch (err) {
      logger.error({ err }, "api /impact failed");
      sendError(res, 500, "internal", "Failed to load impact report.");
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

  // ─── /search ───────────────────────────────────────────────────────
  // Powers the Cmd-K palette. Any authenticated role may search (read-only).
  // Mixes repos, PRs, findings, and on-disk learnings into one ranked list,
  // each carrying a client-side deep link the SPA navigates to on Enter.
  router.get("/search", async (req, res) => {
    const raw = req.query.q;
    const q = (typeof raw === "string" ? raw : "").trim();
    const limit = (() => {
      const v = req.query.limit;
      const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 25;
    })();
    if (q.length < 1) {
      sendData(res, { q, results: [] });
      return;
    }
    const ql = q.toLowerCase();
    try {
      const { repos, prs, findings } = searchEntities(q, 20);
      const results: SearchResult[] = [];

      for (const r of repos) {
        const slug = `${r.owner}/${r.repo}`;
        results.push({
          type: "repo",
          title: slug,
          subtitle: r.last_review ? "repository" : "repository · no reviews yet",
          to: `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`,
          owner: r.owner,
          repo: r.repo,
          number: null,
          severity: null,
          score: TYPE_BIAS.repo + bestScore(ql, slug, r.repo),
        });
      }

      for (const p of prs) {
        results.push({
          type: "pr",
          title: p.title ? `#${p.number} · ${p.title}` : `#${p.number}`,
          subtitle: `${p.owner}/${p.repo}${p.author ? ` · @${p.author}` : ""}${p.state ? ` · ${p.state}` : ""}`,
          to: `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/pr/${p.number}`,
          owner: p.owner,
          repo: p.repo,
          number: p.number,
          severity: null,
          score: TYPE_BIAS.pr + bestScore(ql, p.title, p.author, `#${p.number}`, String(p.number)),
        });
      }

      for (const f of findings) {
        const loc = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : `${f.owner}/${f.repo}#${f.number}`;
        results.push({
          type: "finding",
          title: f.title ?? loc,
          subtitle: `${f.owner}/${f.repo}#${f.number} · ${loc}`,
          to: `/repos/${encodeURIComponent(f.owner)}/${encodeURIComponent(f.repo)}/pr/${f.number}`,
          owner: f.owner,
          repo: f.repo,
          number: f.number,
          severity: f.severity,
          score: TYPE_BIAS.finding + bestScore(ql, f.title, f.path),
        });
      }

      // Learnings live on disk (one JSON file per repo), so scan the known
      // repos' files and match on content. Cheap — repo count is small and
      // files are tiny; mirrors how /repos/:owner/:repo already loads them.
      const learningHits = await Promise.all(
        listRepos().map(async ({ owner, repo }) => {
          const learnings = await loadLearningsSafe(deps.learningsDir, owner, repo);
          return learnings
            .filter((l) => l.content.toLowerCase().includes(ql))
            .map<SearchResult>((l) => ({
              type: "learning",
              title: l.content.length > 90 ? `${l.content.slice(0, 90)}…` : l.content,
              subtitle: `learning · ${owner}/${repo}${l.path ? ` · ${l.path}` : ""}`,
              to: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
              owner,
              repo,
              number: null,
              severity: null,
              score: TYPE_BIAS.learning + bestScore(ql, l.content),
            }));
        }),
      );
      for (const arr of learningHits) results.push(...arr);

      results.sort((a, b) => b.score - a.score);
      sendData(res, { q, results: results.slice(0, limit) });
    } catch (err) {
      logger.error({ err, q }, "api /search failed");
      sendError(res, 500, "internal", "Search failed.");
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
