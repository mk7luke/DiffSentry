// Bundled demo fixtures + the read resolver for demo/sandbox mode.
//
// resolveDemoGet(path) maps an /api/v1 GET path to a realistic, hand-built
// response object (the `data` an envelope would carry). The hero flow — the
// Overview, a RepoDetail, and a PRDetail with findings + a unified diff — is
// fully fleshed out; every other endpoint returns a valid, empty-but-typed
// default so no screen crashes. NOTHING here touches the network, so demo mode
// can neither read nor mutate real data. Mutations are refused in api/client.ts.

import type {
  DailyActivityRow,
  DiagnosticsResponse,
  FindingsResponse,
  FindingExplorerRow,
  ImpactReport,
  MeResponse,
  PRDetailResponse,
  PRDiffResponse,
  PRFindingRow,
  PRReviewRow,
  RepoDetailResponse,
  ReposResponse,
} from "../api/types";

// Relative timestamps so the demo always looks "live" (computed at load).
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const hours = (h: number) => h * 3_600_000;
const days = (d: number) => d * 86_400_000;
const ymd = (msAgo: number) => new Date(now - msAgo).toISOString().slice(0, 10);

const OWNER = "acme";
const HERO_REPO = "checkout-api";
const HERO_PR = 142;

// ─── /me — a no-auth, read-only viewer ───────────────────────────────
// authEnabled:false signals "open mode" to the SPA. Every write capability is
// false: in demo mode the dashboard's mutation controls (triage, run review,
// admin forms) are simply never rendered, so there are no dead/erroring buttons.
const ME: MeResponse = {
  user: {
    login: "demo",
    id: 0,
    role: "viewer",
    capabilities: {
      viewDashboard: true,
      triageFindings: false,
      triggerReview: false,
      manageLearnings: false,
      manageConfig: false,
      manageRoles: false,
      viewAudit: false,
      manageNotifications: false,
      manageTokens: false,
    },
  },
  authEnabled: false,
};

// ─── /repos — the Overview ───────────────────────────────────────────
const REPOS: ReposResponse["repos"] = [
  { owner: OWNER, repo: HERO_REPO, prs_reviewed: 24, findings_7d: 11, critical_7d: 2, last_review: iso(hours(2)), approved: 14, changes_requested: 7, commented: 3 },
  { owner: OWNER, repo: "payments-core", prs_reviewed: 31, findings_7d: 9, critical_7d: 1, last_review: iso(hours(6)), approved: 24, changes_requested: 5, commented: 2 },
  { owner: OWNER, repo: "web-dashboard", prs_reviewed: 18, findings_7d: 6, critical_7d: 0, last_review: iso(days(1)), approved: 16, changes_requested: 1, commented: 1 },
];

// 14 days of activity across the repos, weighted toward the hero repo.
function buildActivity(owner: string, repo: string, weight: number, span: number): DailyActivityRow[] {
  const out: DailyActivityRow[] = [];
  for (let i = span - 1; i >= 0; i--) {
    // Deterministic pseudo-variation (no Math.random so the demo is stable).
    const seed = (i * 7 + repo.length * 3) % 5;
    const reviews = Math.max(0, Math.round(weight * (1 + (seed % 3))));
    if (reviews === 0) continue;
    out.push({
      owner,
      repo,
      day: ymd(days(i)),
      reviews,
      critical: seed === 0 ? 1 : 0,
      major: seed % 2,
      minor: seed % 3,
      nit: (seed + 1) % 2,
    });
  }
  return out;
}

const OVERVIEW_ACTIVITY: DailyActivityRow[] = [
  ...buildActivity(OWNER, HERO_REPO, 2, 14),
  ...buildActivity(OWNER, "payments-core", 1, 14),
  ...buildActivity(OWNER, "web-dashboard", 1, 14),
];

const REPOS_RESPONSE: ReposResponse = { repos: REPOS, activity: OVERVIEW_ACTIVITY };

// ─── Findings shared by the PR detail + diff + explorer views ─────────
const UNDECIDED = { accepted: null, snoozed_until: null, triaged_by: null, triaged_at: null, triage_note: null };
const REVIEW_SHA = "b7e4d61";
const REVIEW_AT = iso(hours(2));

const PR_FINDINGS: PRFindingRow[] = [
  {
    id: 9001,
    path: "src/limiter.ts",
    line: 23,
    type: "issue",
    severity: "critical",
    title: "Race condition on the shared rate-limit counter",
    body:
      "`check()` reads the counter with `GET` and writes it back with `SET` as two " +
      "separate round trips. Under concurrent requests for the same client two callers " +
      "can both read the same value and each write `current + 1`, so requests are " +
      "undercounted and the limit can be exceeded.\n\n" +
      "Use an atomic `INCR` (with `EXPIRE` on first write) instead of read-modify-write.",
    fingerprint: "rl-counter-race",
    source: "ai",
    confidence: "high",
    review_id: 5001,
    review_sha: REVIEW_SHA,
    review_at: REVIEW_AT,
    ...UNDECIDED,
  },
  {
    id: 9002,
    path: "src/limiter.ts",
    line: 25,
    type: "issue",
    severity: "major",
    title: "Rate-limit keys are written without a TTL",
    body:
      "`redis.set(key, …)` never sets an expiry, so every distinct client id leaves a " +
      "key behind forever. An attacker rotating the `x-client-id` header can mint " +
      "unbounded keys and exhaust Redis memory.\n\n" +
      "Set a TTL on the window (e.g. `SET key v PX 60000` or `EXPIRE` after the first `INCR`).",
    fingerprint: "rl-no-ttl",
    source: "ai",
    confidence: "high",
    review_id: 5001,
    review_sha: REVIEW_SHA,
    review_at: REVIEW_AT,
    ...UNDECIDED,
  },
  {
    id: 9003,
    path: "src/gateway/auth.ts",
    line: 15,
    type: "security",
    severity: "minor",
    title: "Rate limiter fails open when Redis is unavailable",
    body:
      "The new `try/catch` swallows a Redis error and calls `next()`, letting the request " +
      "through unthrottled. For an auth gateway this fails open: a Redis outage disables " +
      "rate limiting entirely. Prefer failing closed (return `429`/`503`) or degrade to a " +
      "local in-memory limiter.",
    fingerprint: "rl-fail-open",
    source: "safety",
    confidence: "medium",
    review_id: 5001,
    review_sha: REVIEW_SHA,
    review_at: REVIEW_AT,
    ...UNDECIDED,
  },
];

const HERO_REVIEW: PRReviewRow = {
  id: 5001,
  created_at: REVIEW_AT,
  sha: REVIEW_SHA,
  profile: "assertive",
  approval: "request_changes",
  summary:
    "## Summary\n\n" +
    "This adds a Redis-backed token-bucket limiter to the auth gateway. The approach is " +
    "sound, but there are **two blocking issues** in `src/limiter.ts`:\n\n" +
    "1. The counter update is a non-atomic read-modify-write (race condition).\n" +
    "2. Keys are written without a TTL, allowing unbounded memory growth.\n\n" +
    "There's also a fail-open path in the gateway when Redis is unreachable. Switching to " +
    "`INCR` + `EXPIRE` resolves the first two; decide explicitly how to behave on a Redis " +
    "outage for the third.",
  risk_score: 82,
  risk_level: "critical",
  files_processed: 7,
  files_skipped_similar: 1,
  files_skipped_trivial: 2,
  finding_count: 3,
};

const PR_DETAIL: PRDetailResponse = {
  owner: OWNER,
  repo: HERO_REPO,
  number: HERO_PR,
  pr: {
    owner: OWNER,
    repo: HERO_REPO,
    number: HERO_PR,
    title: "Add Redis-backed rate limiter to the auth gateway",
    author: "jordan-lee",
    state: "open",
    head_sha: REVIEW_SHA,
    base_sha: "a1c0f4e",
    created_at: iso(hours(5)),
  },
  reviews: [HERO_REVIEW],
  latest: HERO_REVIEW,
  findings: PR_FINDINGS,
  events: [
    { id: 7001, ts: iso(hours(5)), kind: "pull_request.opened", payload_json: null },
    { id: 7002, ts: iso(hours(2)), kind: "review.completed", payload_json: JSON.stringify({ approval: "request_changes", findings: 3 }) },
  ],
};

// A real unified diff. New-file line numbers are chosen so the findings above
// anchor onto the right rows in the inline diff viewer (limiter.ts:23 / :25,
// auth.ts:15).
const HERO_DIFF = `diff --git a/src/limiter.ts b/src/limiter.ts
new file mode 100644
index 0000000..b7e4d61
--- /dev/null
+++ b/src/limiter.ts
@@ -0,0 +1,43 @@
+import { redis } from "../redis";
+import { logger } from "../logger";
+
+export interface RateLimitResult {
+  allowed: boolean;
+  remaining: number;
+  resetAt: number;
+}
+
+const WINDOW_MS = 60_000;
+const MAX_REQUESTS = 100;
+
+/**
+ * Token-bucket rate limiter backed by a shared Redis counter, keyed per
+ * client id. The bucket is refilled lazily on each check.
+ */
+export class RateLimiter {
+  constructor(private readonly prefix = "rl:") {}
+
+  async check(clientId: string): Promise<RateLimitResult> {
+    const key = this.prefix + clientId;
+    // Read the counter, bump it, write it back.
+    const current = Number(await redis.get(key)) || 0;
+    const next = current + 1;
+    await redis.set(key, String(next));
+
+    if (next > MAX_REQUESTS) {
+      logger.warn({ clientId, next }, "rate limit exceeded");
+      return { allowed: false, remaining: 0, resetAt: Date.now() + WINDOW_MS };
+    }
+
+    return {
+      allowed: true,
+      remaining: MAX_REQUESTS - next,
+      resetAt: Date.now() + WINDOW_MS,
+    };
+  }
+
+  async reset(clientId: string): Promise<void> {
+    await redis.del(this.prefix + clientId);
+  }
+}
diff --git a/src/gateway/auth.ts b/src/gateway/auth.ts
index a1c0f4e..3d2b9aa 100644
--- a/src/gateway/auth.ts
+++ b/src/gateway/auth.ts
@@ -6,10 +6,16 @@ import { RateLimiter } from "../limiter";
 const limiter = new RateLimiter();

 export async function authGate(req: Request, res: Response, next: NextFunction) {
   const clientId = req.header("x-client-id") ?? req.ip;
   let result;
-  result = await limiter.check(clientId);
+  try {
+    result = await limiter.check(clientId);
+  } catch (err) {
+    // Redis down: let the request through rather than blocking traffic.
+    return next();
+  }
   if (!result.allowed) {
     res.status(429).json({ error: "rate_limited" });
     return;
   }
+  res.setHeader("x-ratelimit-remaining", String(result.remaining));
   next();
 }
`;

const PR_DIFF: PRDiffResponse = {
  owner: OWNER,
  repo: HERO_REPO,
  number: HERO_PR,
  pr: PR_DETAIL.pr,
  diff: HERO_DIFF,
  truncated: false,
  diffError: null,
  findings: PR_FINDINGS,
};

// ─── RepoDetail for the hero repo ────────────────────────────────────
const REPO_CONFIG_YAML = `# .diffsentry.yaml
profile: assertive
review:
  paths:
    include:
      - "src/**"
    exclude:
      - "**/*.test.ts"
      - "dist/**"
focus:
  - security
  - concurrency
`;

const REPO_DETAIL: RepoDetailResponse = {
  owner: OWNER,
  repo: HERO_REPO,
  sparkline: [
    { created_at: iso(days(6)), risk_score: 40, number: 131 },
    { created_at: iso(days(5)), risk_score: 22, number: 134 },
    { created_at: iso(days(4)), risk_score: 61, number: 137 },
    { created_at: iso(days(2)), risk_score: 35, number: 139 },
    { created_at: iso(days(1)), risk_score: 18, number: 141 },
    { created_at: REVIEW_AT, risk_score: 82, number: HERO_PR },
  ],
  hotPaths: [
    { path: "src/limiter.ts", critical: 2, major: 1, total: 5 },
    { path: "src/gateway/auth.ts", critical: 1, major: 2, total: 4 },
    { path: "src/checkout/session.ts", critical: 0, major: 3, total: 6 },
  ],
  topRules: [
    { rule_name: "no-unsynchronized-counter", source: "ai", hits: 4, example_pr: HERO_PR },
    { rule_name: "require-redis-ttl", source: "ai", hits: 3, example_pr: HERO_PR },
    { rule_name: "no-fail-open-auth", source: "safety", hits: 2, example_pr: 139 },
  ],
  prs: [
    {
      number: HERO_PR,
      title: "Add Redis-backed rate limiter to the auth gateway",
      author: "jordan-lee",
      latest_at: REVIEW_AT,
      review_count: 1,
      latest_approval: "request_changes",
      latest_risk_score: 82,
      latest_risk_level: "critical",
      total_findings: 3,
      worst_severity: "critical",
    },
    {
      number: 141,
      title: "Cache product catalog lookups",
      author: "sam-rivera",
      latest_at: iso(days(1)),
      review_count: 2,
      latest_approval: "approve",
      latest_risk_score: 18,
      latest_risk_level: "low",
      total_findings: 1,
      worst_severity: "nit",
    },
    {
      number: 139,
      title: "Harden webhook signature verification",
      author: "jordan-lee",
      latest_at: iso(days(2)),
      review_count: 1,
      latest_approval: "comment",
      latest_risk_score: 35,
      latest_risk_level: "moderate",
      total_findings: 2,
      worst_severity: "major",
    },
  ],
  issues: [],
  activity: buildActivity(OWNER, HERO_REPO, 2, 30),
  approvalMix: [
    { approval: "approve", count: 14 },
    { approval: "comment", count: 6 },
    { approval: "request_changes", count: 4 },
  ],
  learnings: [
    { id: "l1", repo: `${OWNER}/${HERO_REPO}`, content: "Prefer atomic Redis ops (INCR/EXPIRE) over read-modify-write for counters.", createdAt: iso(days(20)) },
    { id: "l2", repo: `${OWNER}/${HERO_REPO}`, content: "Auth-path failures should fail closed; never bypass the gateway on a dependency error.", createdAt: iso(days(12)) },
  ],
  config: REPO_CONFIG_YAML,
};

// Findings explorer rows (reuse the hero findings + a couple from other PRs).
const EXPLORER_ROWS: FindingExplorerRow[] = [
  ...PR_FINDINGS.map((f) => ({
    id: f.id,
    owner: OWNER,
    repo: HERO_REPO,
    number: HERO_PR,
    created_at: f.review_at,
    path: f.path,
    line: f.line,
    severity: f.severity,
    title: f.title,
    source: f.source,
    fingerprint: f.fingerprint,
    type: f.type,
    author: "jordan-lee",
    ...UNDECIDED,
  })),
  {
    id: 8901,
    owner: OWNER,
    repo: "payments-core",
    number: 88,
    created_at: iso(hours(6)),
    path: "src/charge/retry.ts",
    line: 64,
    severity: "major",
    title: "Retry loop has no backoff or max attempts",
    source: "ai",
    fingerprint: "retry-unbounded",
    type: "issue",
    author: "sam-rivera",
    ...UNDECIDED,
  },
];

const FINDINGS_RESPONSE: FindingsResponse = {
  rows: EXPLORER_ROWS,
  total: EXPLORER_ROWS.length,
  groups: [
    { fingerprint: "rl-counter-race", title: "Race condition on the shared rate-limit counter", severity: "critical", occurrences: 4, repos: 2, last_seen: REVIEW_AT },
    { fingerprint: "rl-no-ttl", title: "Rate-limit keys are written without a TTL", severity: "major", occurrences: 3, repos: 1, last_seen: REVIEW_AT },
    { fingerprint: "retry-unbounded", title: "Retry loop has no backoff or max attempts", severity: "major", occurrences: 2, repos: 1, last_seen: iso(hours(6)) },
  ],
  filters: { limit: 100, offset: 0 },
};

// ─── /impact ─────────────────────────────────────────────────────────
const IMPACT: ImpactReport = {
  range: { days: 30, label: "Last 30 days", since: iso(days(30)), until: iso(0) },
  repo: null,
  minutesPerFinding: 15,
  current: {
    reviews: 73,
    prsCovered: 58,
    mergedPrsCovered: 41,
    repos: 3,
    findings: 126,
    bySeverity: { critical: 9, major: 34, minor: 52, nit: 31 },
    mergedBySeverity: { critical: 6, major: 22, minor: 33, nit: 18 },
    criticalMajorCaughtBeforeMerge: 28,
    accepted: 71,
    dismissed: 22,
    pending: 33,
    acceptanceRate: 0.76,
    timeSavedMinutes: 1890,
  },
  previous: {
    reviews: 61,
    prsCovered: 47,
    mergedPrsCovered: 35,
    repos: 3,
    findings: 98,
    bySeverity: { critical: 5, major: 27, minor: 41, nit: 25 },
    mergedBySeverity: { critical: 3, major: 18, minor: 27, nit: 14 },
    criticalMajorCaughtBeforeMerge: 21,
    accepted: 54,
    dismissed: 19,
    pending: 25,
    acceptanceRate: 0.74,
    timeSavedMinutes: 1470,
  },
  recurring: { distinctFingerprints: 18, totalOccurrences: 44, repeatsPrevented: 26, firstHalf: 27, secondHalf: 17 },
  trend: Array.from({ length: 14 }, (_, i) => {
    const idx = 13 - i;
    const seed = (idx * 5) % 6;
    return {
      day: ymd(days(idx)),
      reviews: 3 + (seed % 4),
      critical: seed === 0 ? 1 : 0,
      major: seed % 3,
      minor: (seed + 1) % 4,
      nit: seed % 2,
    };
  }),
  generatedAt: iso(0),
};

// ─── First-run diagnostics — report a healthy, complete instance so the
//     setup wizard stays hidden in the demo. ────────────────────────────
const DIAGNOSTICS: DiagnosticsResponse = {
  checks: [
    { id: "github-app", category: "github", label: "GitHub App", status: "ok", detail: "Connected to 3 repositories." },
    { id: "ai-provider", category: "ai", label: "AI provider", status: "ok", detail: "Provider reachable." },
    { id: "persistence", category: "persistence", label: "Persistence", status: "ok", detail: "Demo dataset loaded." },
  ],
  summary: { ok: 3, warn: 0, fail: 0 },
  incomplete: false,
  config: { provider: "demo", model: "demo-model", botName: "diffsentry", authEnabled: false, oauthConfigured: false, dashboardUrl: null, persistence: true },
  db: { enabled: true, sizeBytes: 0, lastReviewAt: REVIEW_AT, counts: emptyHealthCounts() },
};

function emptyHealthCounts() {
  return {
    repos: 3, prs: 12, reviews: 73, findings: 126, issues: 0, events: 240, pattern_hits: 41,
    db_bytes: 0, oldest_review: iso(days(30)), newest_review: REVIEW_AT,
  };
}

// ─── Resolver ────────────────────────────────────────────────────────
// Match an /api/v1-relative path (no leading /api/v1) to its fixture.
const PR_RE = /^\/repos\/[^/]+\/[^/]+\/prs\/\d+$/;
const PR_DIFF_RE = /^\/repos\/[^/]+\/[^/]+\/prs\/\d+\/diff$/;
const REPO_RE = /^\/repos\/[^/]+\/[^/]+$/;
const REPO_CONFIG_RE = /^\/repos\/[^/]+\/[^/]+\/config$/;
const REPO_SETTINGS_RE = /^\/repos\/[^/]+\/[^/]+\/settings$/;
const REPO_LEARNINGS_RE = /^\/repos\/[^/]+\/[^/]+\/learnings$/;
const AUTHOR_RE = /^\/analytics\/authors\/[^/]+$/;

/**
 * Resolve a demo read. `path` is relative to the /api/v1 mount (e.g. "/repos").
 * Returns the `data` payload (already unwrapped from the envelope). Unknown
 * endpoints return an empty object — defensive only; the cases below cover
 * every endpoint the read-only viewer UI can reach.
 */
export function resolveDemoGet<T>(path: string): T {
  const p = path.split("?")[0];
  const out = match(p);
  return out as T;
}

function match(p: string): unknown {
  switch (p) {
    case "/me":
      return ME;
    case "/repos":
      return REPOS_RESPONSE;
    case "/impact":
      return IMPACT;
    case "/findings":
      return FINDINGS_RESPONSE;
    case "/findings/recurring":
      return { rows: [], filters: { limit: 100, offset: 0 } };
    case "/queue":
      return { entries: [] };
    case "/activity":
      return { rows: [], nextBefore: null, hasMore: false, kinds: [] };
    case "/patterns":
      return { rules: [] };
    case "/learnings":
      return { global: [], repos: [{ owner: OWNER, repo: HERO_REPO, learnings: REPO_DETAIL.learnings }], duplicates: [] };
    case "/health":
      return { counts: emptyHealthCounts(), logs: [] };
    case "/search":
      return { q: "", results: [] };
    case "/diagnostics":
      return DIAGNOSTICS;
    case "/diagnostics/github":
      return { app: null, installations: [], webhook: { configuredUrl: null, deliveries: [] }, rateLimit: null, reachable: true, connectedRepos: 3, installationCount: 1 };
    case "/settings":
      return { settings: { pauseAll: false, autoReview: true, defaultProfile: "assertive", logLevel: "info", maxFiles: null } };
    case "/settings/branding":
      return { instanceName: "DiffSentry", accentColor: "#5a8dff" };
    case "/cost":
      return demoCost();
    case "/analytics/authors":
      return { days: 30, authors: [], series: [] };
    case "/analytics/trends":
      return { days: 30, activity: OVERVIEW_ACTIVITY, riskDistribution: [], hotPaths: REPO_DETAIL.hotPaths, hotPathSeries: [] };
    // Admin-only endpoints the viewer UI never links to — empty but valid.
    case "/audit":
      return { rows: [], total: 0, actions: [], roles: [] };
    case "/tokens":
      return { tokens: [], availableScopes: ["read", "review"] };
    case "/rules":
      return { rules: [] };
    case "/notifications":
      return { channels: [], rules: [], deliveries: [], channelTypes: ["slack", "discord", "webhook", "email"], eventTypes: ["finding", "review_failed", "budget", "digest", "any"] };
    case "/webhooks":
      return { rows: [], total: 0, events: [], repos: [] };
    default:
      break;
  }
  if (PR_DIFF_RE.test(p)) return PR_DIFF;
  if (PR_RE.test(p)) return PR_DETAIL;
  if (REPO_CONFIG_RE.test(p)) return demoRepoConfig();
  if (REPO_SETTINGS_RE.test(p)) return { owner: OWNER, repo: HERO_REPO, settings: { autoReview: null, profile: null, maxFiles: null } };
  if (REPO_LEARNINGS_RE.test(p)) return { owner: OWNER, repo: HERO_REPO, learnings: REPO_DETAIL.learnings };
  if (REPO_RE.test(p)) return REPO_DETAIL;
  if (AUTHOR_RE.test(p)) return { author: "jordan-lee", days: 30, stat: null, series: [], hotPaths: [], prs: [] };
  // Unknown endpoint — empty object keeps the UI from throwing.
  return {};
}

function demoCost() {
  return {
    range: "30d",
    since: iso(days(30)),
    group: null,
    totals: { cost_usd: 18.42, input_tokens: 2_140_000, output_tokens: 312_000, events: 73 },
    monthToDate: 18.42,
    projectedMonthEnd: 24.1,
    dayOfMonth: 23,
    daysInMonth: 30,
    byModel: [{ key: "demo-model", cost_usd: 18.42, input_tokens: 2_140_000, output_tokens: 312_000, events: 73 }],
    byRepo: [
      { key: `${OWNER}/${HERO_REPO}`, cost_usd: 8.9, input_tokens: 1_010_000, output_tokens: 150_000, events: 31 },
      { key: `${OWNER}/payments-core`, cost_usd: 6.2, input_tokens: 720_000, output_tokens: 108_000, events: 24 },
      { key: `${OWNER}/web-dashboard`, cost_usd: 3.32, input_tokens: 410_000, output_tokens: 54_000, events: 18 },
    ],
    byKind: [{ key: "review", cost_usd: 18.42, input_tokens: 2_140_000, output_tokens: 312_000, events: 73 }],
    daily: [],
    models: ["demo-model"],
    budgets: [{ scope: "global", monthlyUsd: 100, spentUsd: 18.42, pct: 0.18, exceeded: false, updatedBy: null, updatedAt: null }],
  };
}

function demoRepoConfig() {
  return {
    owner: OWNER,
    repo: HERO_REPO,
    defaultBranch: "main",
    yaml: REPO_CONFIG_YAML,
    exists: true,
    parsed: { profile: "assertive" },
    parseError: null,
    effective: { profile: "assertive" },
    schema: { type: "object" as const, properties: {} },
    editable: false,
  };
}
