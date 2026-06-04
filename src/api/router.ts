import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { getRecentLogs, logger } from "../logger.js";
import { LearningsStore } from "../learnings.js";
import type { Learning } from "../types.js";
import { createNoopCsrf, type AuthRuntime, type CsrfRuntime } from "../dashboard/auth.js";
import {
  createRequireRole,
  getPrincipal,
  isRole,
  loadRoleConfigFromEnv,
  resolveActor,
  getActor,
  type RoleConfig,
} from "../dashboard/roles.js";
import {
  insertAuditLog,
  setRole,
  triageFinding,
  bulkTriageFindings,
  getFindingCoords,
  getFindingIdsByFingerprint,
  type FindingCoords,
} from "../storage/dao.js";
import {
  applyBrandingOverrides,
  isValidAccent,
  normalizeAccent,
  resolveBranding,
  sanitizeInstanceName,
  type BrandingChanges,
} from "../dashboard/branding.js";
import { bus } from "../realtime/bus.js";
import { registerStreamRoute } from "./stream.js";
import { registerActionRoutes, type ReviewerActions } from "./actions.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerCostRoutes } from "./cost.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerTokenRoutes } from "./tokens.js";
import { authenticateBearer, extractBearer, requiredScopeForMethod } from "./token-auth.js";
import { buildOpenApiSpec } from "./openapi.js";
import { renderDocsPage } from "./docs.js";
import { registerRuleRoutes } from "./rules.js";
import { registerDiagnosticsRoutes, type DiagnosticsProvider } from "./diagnostics.js";
import { registerConfigRoutes, loadRepoConfigYaml } from "./config.js";
import { registerLearningRoutes } from "./learnings.js";
import { reviewQueue } from "../realtime/queue.js";
import { registerWebhookRoutes, type ReplayWebhook } from "./webhooks.js";
import {
  getApprovalMix,
  getAuditActions,
  getAuditLog,
  getAuthorDailyActivity,
  getAuthorHotPaths,
  getAuthorLeaderboard,
  getAuthorPRs,
  getDailyActivity,
  getEvents,
  getFindingsForPR,
  getHealthCounts,
  getHotPaths,
  getHotPathTrends,
  getImpact,
  getPR,
  getPRReviews,
  getPatternRules,
  getRecentIssues,
  getRecentPRsWithReviews,
  getRepoOverview,
  getRiskDistribution,
  getRoleOverrides,
  getSparkline,
  getTopRules,
  listRepos,
  queryFindings,
  queryFingerprintGroups,
  queryRecurringFindings,
  repoExists,
  searchEntities,
  type AuthorStatRow,
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
  /** First-run diagnostics surface (AI probe + GitHub App introspection).
   * The /diagnostics routes are always mounted; when this is omitted only the
   * provider-backed probes (test-ai, GitHub introspection) return an explicit
   * "unavailable" result — the static env+DB checks and webhook self-test still
   * work. */
  diagnostics?: DiagnosticsProvider;
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
    triage: str("triage"),
    ageDays: num("age") ?? undefined,
    limit: num("limit") ?? 100,
    offset: num("offset") ?? 0,
  };
}

// ─── Triage helpers ──────────────────────────────────────────────────────
type TriageState = "accepted" | "dismissed" | "snoozed";

/** Triage opts for triageFinding/bulkTriageFindings derived from a state. */
interface TriageWrite {
  accepted?: boolean | null;
  snoozedUntil?: string | null;
  triagedBy?: string | null;
  triageNote?: string | null;
}

/**
 * Translate the public { state, until, note } payload into the DAO write shape.
 * accept/dismiss are terminal (they clear any snooze); snooze sets the deadline
 * and leaves the accept/dismiss decision untouched. Returns null when the
 * payload is invalid (bad state, or snooze without a usable future date).
 */
function buildTriageWrite(
  state: unknown,
  until: unknown,
  note: unknown,
  actorLogin: string | null,
): TriageWrite | null {
  if (state !== "accepted" && state !== "dismissed" && state !== "snoozed") return null;
  const write: TriageWrite = { triagedBy: actorLogin };
  if (typeof note === "string" && note.trim().length > 0) write.triageNote = note.trim().slice(0, 2000);
  if (state === "accepted") {
    write.accepted = true;
    write.snoozedUntil = null;
  } else if (state === "dismissed") {
    write.accepted = false;
    write.snoozedUntil = null;
  } else {
    // snoozed — require a parseable date that is in the future.
    if (typeof until !== "string" || until.trim().length === 0) return null;
    const ms = Date.parse(until);
    if (!Number.isFinite(ms)) return null;
    if (ms <= Date.now()) return null;
    write.snoozedUntil = new Date(ms).toISOString();
  }
  return write;
}

/**
 * Audit + publish a completed triage. One audit_log row summarizes the write;
 * an `action.performed` event is emitted per distinct PR the affected findings
 * live on (deduped) so any open PR view refreshes live.
 */
function recordTriage(
  actorLogin: string | null,
  actorRole: string | null,
  coords: FindingCoords[],
  state: TriageState,
  payload: Record<string, unknown>,
): void {
  const targetRef = coords.length === 1 ? String(coords[0].id) : `${coords.length} findings`;
  insertAuditLog({
    actorLogin,
    actorRole,
    action: "finding.triage",
    targetType: "finding",
    targetRef,
    payload: { state, ...payload },
    result: "ok",
  });
  const seen = new Set<string>();
  for (const c of coords) {
    const key = `${c.owner}/${c.repo}#${c.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bus.publish("action.performed", {
      owner: c.owner,
      repo: c.repo,
      number: c.number,
      action: "triage",
      actor: actorLogin,
      role: actorRole,
      result: "ok",
      detail: state,
    });
  }
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
  const learningsStore = new LearningsStore(deps.learningsDir);

  const authEnabled = !!deps.auth;
  const roleConfig = deps.roleConfig ?? loadRoleConfigFromEnv();
  // CSRF verify is bound to the session secret when auth is on; in open mode
  // (no OAuth) there is no session to bind against, so writes pass freely.
  const csrf: CsrfRuntime = deps.auth ? deps.auth.csrf : createNoopCsrf();
  const requireRole = createRequireRole((req) => resolveActor(req, roleConfig, authEnabled));

  // Parse JSON bodies for write endpoints. Scoped to /api/v1 only — the raw
  // webhook body parser on /webhook is mounted separately and untouched.
  router.use(express.json({ limit: "1mb" }));

  // ─── Public API surface (no auth) ──────────────────────────────────
  // The machine-readable spec and the human docs page sit BEFORE the auth gate
  // so the API is documented without signing in. Neither exposes data.
  router.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiSpec());
  });
  router.get("/docs", (_req, res) => {
    res.type("html").send(renderDocsPage());
  });

  // Auth gate — JSON 401 instead of the HTML-redirect the dashboard uses.
  // Accepts EITHER a bearer API token OR a cookie session, attaching the
  // resolved principal to req.dsPrincipal (RBAC + scope checks read it).
  // `req.path` here is relative to the /api/v1 mount.
  router.use((req, res, next) => {
    // 1. Bearer token — checked first and honoured even in open mode, so token
    //    scopes are enforced regardless of whether OAuth is configured.
    const bearer = extractBearer(req.headers.authorization);
    if (bearer) {
      const principal = authenticateBearer(bearer);
      if (!principal) {
        sendError(res, 401, "unauthorized", "Invalid or revoked API token.");
        return;
      }
      (req as Request & { dsPrincipal?: unknown }).dsPrincipal = principal;
      next();
      return;
    }
    // 2. Cookie session (when OAuth is enabled). Open mode → no principal; the
    //    actor resolver treats the local operator as admin.
    if (!deps.auth) return next();
    const user = deps.auth.authenticate(req);
    if (!user) {
      sendError(res, 401, "unauthorized", "Authentication required.");
      return;
    }
    (req as Request & { dsUser?: { login: string; id: number } }).dsUser = user;
    (req as Request & { dsPrincipal?: unknown }).dsPrincipal = {
      kind: "session",
      login: user.login,
      id: user.id,
    };
    next();
  });

  // ─── Token scope gate ──────────────────────────────────────────────
  // For token principals only: (1) deny admin-only endpoints outright, then
  // (2) enforce the per-method scope — GET/HEAD need `read`, every mutating
  // method needs `review`. Cookie sessions skip this and are gated by RBAC
  // (requireRole) instead.
  //
  // The admin deny is defense in depth: each admin route already carries
  // requireRole('admin'), which a token (role ≤ author) never meets — but
  // denying here keeps the invariant "API tokens never reach admin endpoints"
  // enforced in one obvious place rather than emerging from the role math.
  // `req.path` is relative to the /api/v1 mount, so it matches `/audit`,
  // `/roles`, `/tokens`, and `/tokens/:id`.
  const ADMIN_ONLY_PATH = /^\/(audit|roles|tokens)(\/|$)/;
  router.use((req, res, next) => {
    const principal = getPrincipal(req);
    if (principal?.kind !== "token") return next();
    if (ADMIN_ONLY_PATH.test(req.path)) {
      sendError(res, 403, "forbidden", "API tokens cannot access admin endpoints; use a dashboard session.");
      return;
    }
    const needed = requiredScopeForMethod(req.method);
    if (!principal.scopes.includes(needed)) {
      sendError(res, 403, "forbidden", `This API token lacks the '${needed}' scope.`);
      return;
    }
    next();
  });

  // CSRF for mutating routes, principal-aware: bearer-token requests are not
  // CSRF-able (no ambient cookie a browser would auto-send), so they bypass the
  // double-submit check; cookie sessions still require X-CSRF-Token.
  const writeCsrf: CsrfRuntime = {
    ensure: csrf.ensure,
    tokenFor: csrf.tokenFor,
    verify: (req, res, next) => {
      if (getPrincipal(req)?.kind === "token") return next();
      return csrf.verify(req, res, next);
    },
  };

  // ─── /stream (SSE) ─────────────────────────────────────────────────
  // Mounted behind the auth gate above; any authenticated role may subscribe.
  registerStreamRoute(router);

  // ─── Command actions (write, author+) ──────────────────────────────
  // Only when a reviewer is wired in (server.ts). The full write contract —
  // requireRole + CSRF + audit_log + bus event — lives in registerActionRoutes.
  if (deps.reviewer) {
    registerActionRoutes(router, { reviewer: deps.reviewer, requireRole, csrf: writeCsrf });
  }

  // ─── Notification settings (admin write) ───────────────────────────
  // Channels, alert rules, test-send, and the delivery log. No reviewer
  // dependency — always mounted. Admin-gated inside registerNotificationRoutes.
  registerNotificationRoutes(router, { requireRole, csrf });

  // ─── Cost (read for all; budget writes are admin) ──────────────────
  registerCostRoutes(router, { requireRole, csrf });

  // ─── Settings (operator controls, admin) ───────────────────────────
  // Global + per-repo overrides (pause-all, auto-review, profile, log level,
  // max files). Same write contract as the actions above. Always mounted —
  // unlike actions, settings don't need a reviewer to be useful.
  registerSettingsRoutes(router, { requireRole, csrf });

  // ─── API token administration (admin, cookie-only) ─────────────────
  // create/list/revoke. requireRole('admin') keeps tokens out (a token
  // principal resolves to ≤ author), so these are operator-only.
  registerTokenRoutes(router, { requireRole, csrf: writeCsrf });

  // ─── Custom anti-pattern rules (admin) ─────────────────────────────
  // CRUD + a no-persist tester. Independent of the reviewer surface, so it is
  // always mounted: the same write contract (requireRole('admin') + CSRF +
  // audit_log + bus event) as the command actions above.
  registerRuleRoutes(router, { requireRole, csrf });

  // ─── Guided first-run diagnostics (read viewer+, tests author+) ─────
  // Always mounted: the static env+DB checks (and the webhook self-test) need
  // no provider and drive the setup wizard, so they must work even on a
  // minimally-wired instance. Provider-backed probes (AI test, GitHub
  // introspection) answer "unavailable" explicitly when no provider is passed.
  registerDiagnosticsRoutes(router, { diagnostics: deps.diagnostics, requireRole, csrf, authEnabled });

  // ─── Repo config (read viewer+, write admin) ───────────────────────
  // GET is always useful; PUT degrades to a 503 when no octokit is wired in.
  registerConfigRoutes(router, {
    getInstallationOctokit: deps.getInstallationOctokit,
    requireRole,
    csrf,
  });

  // ─── Learnings management (read: any role; write: author+ with CSRF) ─
  // Independent of the reviewer — operates directly on the JSON store the
  // engine reads at review time, so edits here are reflected in future reviews.
  registerLearningRoutes(router, { learnings: learningsStore, requireRole, csrf });

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
        loadRepoConfigYaml(deps.getInstallationOctokit, owner, repo),
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

  // ─── /findings/recurring ───────────────────────────────────────────
  // Fingerprints ranked by how often they reappear, with a triage rollup so
  // the UI can dismiss a whole class at once. Read-only; any authed role.
  router.get("/findings/recurring", (req, res) => {
    try {
      const filters = parseFindingFilters(req.query as Record<string, unknown>);
      const rows = queryRecurringFindings(filters, filters.limit ?? 100);
      sendData(res, { rows, filters });
    } catch (err) {
      logger.error({ err }, "api /findings/recurring failed");
      sendError(res, 500, "internal", "Failed to load recurring findings.");
    }
  });

  // ─── /findings/triage (bulk write, author+) ─────────────────────────
  // Apply one triage state to many findings — by explicit id list or by
  // fingerprint (dismiss/accept a whole recurring class). Full write contract:
  // requireRole('author') + CSRF + audit_log + bus event per affected PR.
  router.post("/findings/triage", requireRole("author"), csrf.verify, (req, res) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const write = buildTriageWrite(body.state, body.until, body.note, actor?.login ?? null);
    if (!write) {
      sendError(res, 400, "bad_request", "Body needs state ('accepted'|'dismissed'|'snoozed') and, for snoozed, a future 'until' date.");
      return;
    }
    // Resolve the target id set: an explicit id list, or every finding in a
    // fingerprint class. An explicit list must be all positive integers — a
    // malformed entry is rejected (400) rather than silently dropped, and the
    // list is de-duplicated so a repeated id isn't counted twice.
    let ids: number[];
    // Did the caller pass an explicit id list? Explicit ids are all-or-nothing
    // (every id must resolve); a fingerprint class is whatever currently matches.
    let fromIds = false;
    if (Array.isArray(body.ids)) {
      fromIds = true;
      // An explicitly-provided id list must be non-empty — reject `ids: []`
      // here rather than letting it fall through to the generic
      // "no ids/fingerprint" error, which conflates it with an unmatched class.
      if (body.ids.length === 0) {
        sendError(res, 400, "bad_request", "'ids' must be a non-empty array of positive integers.");
        return;
      }
      const parsed = body.ids.map((v) => (typeof v === "number" ? v : Number(v)));
      if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
        sendError(res, 400, "bad_request", "'ids' must contain only positive integers.");
        return;
      }
      ids = [...new Set(parsed)];
    } else if (typeof body.fingerprint === "string" && body.fingerprint.length > 0) {
      ids = getFindingIdsByFingerprint(body.fingerprint);
    } else {
      sendError(res, 400, "bad_request", "Provide a non-empty 'ids' array or a 'fingerprint'.");
      return;
    }
    if (ids.length === 0) {
      sendError(res, 400, "bad_request", "Provide a non-empty 'ids' array or a 'fingerprint' that matches findings.");
      return;
    }
    if (ids.length > 1000) {
      sendError(res, 400, "bad_request", "Too many findings in one request (max 1000).");
      return;
    }
    try {
      // Resolve coordinates first so we only triage + audit findings that
      // actually exist; a request whose ids match nothing is a 404, and we
      // never write a misleading audit row for zero real matches.
      const coords = getFindingCoords(ids);
      if (coords.length === 0) {
        sendError(res, 404, "not_found", "No findings matched the given ids or fingerprint.");
        return;
      }
      // Explicit id requests are all-or-nothing: if any requested id is absent,
      // 404 before writing rather than partially triaging the subset that
      // exists. (Fingerprint-class triage resolves to whatever currently matches,
      // so it has no such requirement.)
      if (fromIds && coords.length !== ids.length) {
        const found = new Set(coords.map((c) => c.id));
        const missing = ids.filter((n) => !found.has(n));
        sendError(res, 404, "not_found", `Unknown finding id(s): ${missing.join(", ")}.`);
        return;
      }
      const matchedIds = coords.map((c) => c.id);
      const changed = bulkTriageFindings({ ids: matchedIds, ...write });
      recordTriage(actor?.login ?? null, actor?.role ?? null, coords, body.state as TriageState, {
        until: write.snoozedUntil ?? undefined,
        note: write.triageNote ?? undefined,
        requested: ids.length,
        matched: matchedIds.length,
        changed,
      });
      sendData(res, { requested: ids.length, matched: matchedIds.length, changed, state: body.state });
    } catch (err) {
      logger.error({ err }, "api POST /findings/triage failed");
      sendError(res, 500, "internal", "Failed to triage findings.");
    }
  });

  // ─── /findings/:id/triage (single write, author+) ───────────────────
  router.post("/findings/:id/triage", requireRole("author"), csrf.verify, (req: Request<{ id: string }>, res) => {
    const actor = getActor(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      sendError(res, 400, "bad_request", "Invalid finding id.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const write = buildTriageWrite(body.state, body.until, body.note, actor?.login ?? null);
    if (!write) {
      sendError(res, 400, "bad_request", "Body needs state ('accepted'|'dismissed'|'snoozed') and, for snoozed, a future 'until' date.");
      return;
    }
    try {
      // Resolve coordinates first so the write/audit sequence matches the bulk
      // endpoint's resolve-then-write contract: a non-existent id is a 404
      // before any write is attempted.
      const coords = getFindingCoords([id]);
      if (coords.length === 0) {
        sendError(res, 404, "not_found", `No finding with id ${id}.`);
        return;
      }
      // triageFinding returns a boolean; normalize to a 0/1 count so the single
      // and bulk endpoints share the { changed: number } response shape.
      const changed = triageFinding({ findingId: id, ...write }) ? 1 : 0;
      recordTriage(actor?.login ?? null, actor?.role ?? null, coords, body.state as TriageState, {
        until: write.snoozedUntil ?? undefined,
        note: write.triageNote ?? undefined,
        changed,
      });
      sendData(res, { id, changed, state: body.state });
    } catch (err) {
      logger.error({ err, id }, "api POST /findings/:id/triage failed");
      sendError(res, 500, "internal", "Failed to triage finding.");
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

  // ─── /analytics/* ───────────────────────────────────────────────────
  // Read-only org analytics, behind the auth gate above (any role). `days`
  // defaults to 30 and is clamped to 1..365 here so the value echoed in the
  // response matches the window the query layer actually applies.
  const parseDays = (req: Request, dflt = 30): number => {
    const raw = (req.query as Record<string, unknown>).days;
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    const days = Number.isFinite(n) ? n : dflt;
    return Math.min(Math.max(days, 1), 365);
  };

  // Per-author leaderboard + daily sparkline series.
  router.get("/analytics/authors", (req, res) => {
    try {
      const days = parseDays(req);
      sendData(res, {
        days,
        authors: getAuthorLeaderboard(days),
        series: getAuthorDailyActivity(days),
      });
    } catch (err) {
      logger.error({ err }, "api /analytics/authors failed");
      sendError(res, 500, "internal", "Failed to load author analytics.");
    }
  });

  // Single-author drill-down: their leaderboard row, daily series, hot paths,
  // and recent PRs across repos.
  router.get("/analytics/authors/:author", (req, res) => {
    const author = req.params.author;
    try {
      const days = parseDays(req);
      const stat = getAuthorLeaderboard(days).find((a: AuthorStatRow) => a.author === author) ?? null;
      const series = getAuthorDailyActivity(days).filter((r) => r.author === author);
      if (!stat && series.length === 0) {
        sendError(res, 404, "not_found", `No review activity for '${author}' in the last ${days} days.`);
        return;
      }
      sendData(res, {
        author,
        days,
        stat,
        series,
        hotPaths: getAuthorHotPaths(author, days),
        prs: getAuthorPRs(author, days, 50),
      });
    } catch (err) {
      logger.error({ err, author }, "api /analytics/authors/:author failed");
      sendError(res, 500, "internal", "Failed to load author detail.");
    }
  });

  // Org-wide trends: activity time series, risk distribution, hot paths over time.
  router.get("/analytics/trends", (req, res) => {
    try {
      const days = parseDays(req);
      const hotPaths = getHotPathTrends(days, 8);
      sendData(res, {
        days,
        activity: getDailyActivity(null, null, days),
        riskDistribution: getRiskDistribution(days),
        hotPaths: hotPaths.paths,
        hotPathSeries: hotPaths.series,
      });
    } catch (err) {
      logger.error({ err }, "api /analytics/trends failed");
      sendError(res, 500, "internal", "Failed to load trends.");
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

  // ─── /settings/branding ─────────────────────────────────────────────
  // Read the resolved instance branding (name + accent). Any authenticated
  // role may read it — the SPA applies it as the theme accent + wordmark.
  router.get("/settings/branding", (_req, res) => {
    try {
      sendData(res, resolveBranding());
    } catch (err) {
      logger.error({ err }, "api /settings/branding failed");
      sendError(res, 500, "internal", "Failed to load branding.");
    }
  });

  // ─── /settings/branding (admin write) ────────────────────────────────
  // Set or clear the instance name / accent color. Same write contract as
  // /roles: requireRole('admin') + CSRF + audit_log, plus a 'settings.updated'
  // bus event so connected dashboards re-brand live. Validation runs for both
  // fields before any write, so a bad accent can't leave a half-applied change.
  router.post("/settings/branding", requireRole("admin"), csrf.verify, (req, res) => {
    const actor = getActor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hasName = Object.prototype.hasOwnProperty.call(body, "instanceName");
    const hasAccent = Object.prototype.hasOwnProperty.call(body, "accentColor");
    if (!hasName && !hasAccent) {
      sendError(res, 400, "bad_request", "Provide 'instanceName' and/or 'accentColor'.");
      return;
    }

    // Phase 1 — validate everything before any mutation. A bad value rejects
    // here, so we never partially apply a two-field change.
    const changes: BrandingChanges = {};
    if (hasName) {
      const raw = body.instanceName;
      if (raw == null || raw === "") {
        changes.instanceName = null;
      } else {
        const name = sanitizeInstanceName(raw);
        if (!name) {
          sendError(res, 400, "bad_request", "'instanceName' must be a non-empty string.");
          return;
        }
        changes.instanceName = name;
      }
    }
    if (hasAccent) {
      const raw = body.accentColor;
      if (raw == null || raw === "") {
        changes.accentColor = null;
      } else if (!isValidAccent(raw)) {
        sendError(res, 400, "bad_request", "'accentColor' must be a hex color like #5a8dff.");
        return;
      } else {
        changes.accentColor = normalizeAccent(raw);
      }
    }

    // Phase 2 — apply atomically (both fields in one transaction), then audit +
    // broadcast only once the write succeeds.
    try {
      if (!applyBrandingOverrides(changes, actor?.login ?? null)) {
        sendError(res, 500, "internal", "Failed to update branding.");
        return;
      }
      const resolved = resolveBranding();
      insertAuditLog({
        actorLogin: actor?.login ?? null,
        actorRole: actor?.role ?? null,
        action: "settings.branding",
        targetType: "settings",
        targetRef: "global",
        payload: changes,
        result: "ok",
      });
      bus.publish("settings.updated", {
        instanceName: resolved.instanceName,
        accentColor: resolved.accentColor,
        updatedBy: actor?.login ?? null,
      });
      sendData(res, resolved);
    } catch (err) {
      logger.error({ err }, "api POST /settings/branding failed");
      sendError(res, 500, "internal", "Failed to update branding.");
    }
  });

  // Unknown /api/v1/* path → JSON 404 (so the SPA fallback never serves HTML here).
  router.use((_req, res) => {
    sendError(res, 404, "not_found", "Unknown API endpoint.");
  });

  return router;
}
