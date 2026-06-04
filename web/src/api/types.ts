// Shared API types — hand-mirrored from the row interfaces in
// src/dashboard/queries.ts and src/logger.ts. Keep in sync with the backend;
// the JSON API returns these shapes verbatim inside a { data } envelope.

export type Severity = "critical" | "major" | "minor" | "nit";

// ─── Rows (mirror src/dashboard/queries.ts) ─────────────────────────

export interface RepoOverviewRow {
  owner: string;
  repo: string;
  prs_reviewed: number;
  findings_7d: number;
  critical_7d: number;
  last_review: string | null;
}

export interface DailyActivityRow {
  owner: string;
  repo: string;
  day: string; // YYYY-MM-DD
  reviews: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
}

export interface SparklinePoint {
  created_at: string;
  risk_score: number | null;
  number: number;
}

export interface HotPathRow {
  path: string;
  critical: number;
  major: number;
  total: number;
}

export interface RuleHitRow {
  rule_name: string;
  source: string;
  hits: number;
  example_pr: number | null;
}

export interface ApprovalMixRow {
  approval: string | null;
  count: number;
}

export interface RecentPRRow {
  number: number;
  title: string | null;
  author: string | null;
  latest_at: string;
  review_count: number;
  latest_approval: string | null;
  latest_risk_score: number | null;
  latest_risk_level: string | null;
  total_findings: number;
  worst_severity: string | null;
}

export interface IssueRow {
  number: number;
  title: string | null;
  author: string | null;
  state: string | null;
  body: string | null;
  url: string | null;
  labels_json: string | null;
  comment_count: number;
  created_at: string | null;
  first_seen_at: string;
  last_action_at: string | null;
  last_action_kind: string | null;
  action_count: number;
  last_summary: string | null;
  last_plan: string | null;
}

export interface Learning {
  id: string;
  repo: string;
  content: string;
  createdAt: string;
  path?: string;
}

export interface PRRow {
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  author: string | null;
  state: string | null;
  head_sha: string | null;
  base_sha: string | null;
  created_at: string | null;
}

export interface PRReviewRow {
  id: number;
  created_at: string;
  sha: string;
  profile: string | null;
  approval: string | null;
  summary: string | null;
  risk_score: number | null;
  risk_level: string | null;
  files_processed: number | null;
  files_skipped_similar: number | null;
  files_skipped_trivial: number | null;
  finding_count: number;
}

export interface PRFindingRow {
  id: number;
  path: string | null;
  line: number | null;
  type: string | null;
  severity: string | null;
  title: string | null;
  body: string | null;
  fingerprint: string | null;
  source: string | null;
  confidence: string | null;
  review_id: number;
  review_sha: string | null;
  review_at: string;
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  payload_json: string | null;
}

export interface FindingExplorerRow {
  id: number;
  owner: string;
  repo: string;
  number: number;
  created_at: string;
  path: string | null;
  line: number | null;
  severity: string | null;
  title: string | null;
  source: string | null;
  fingerprint: string | null;
  type: string | null;
}

export interface FindingFilters {
  severity?: string;
  source?: string;
  repo?: string;
  q?: string;
  fingerprint?: string;
  ageDays?: number;
  limit?: number;
  offset?: number;
}

export interface FingerprintGroupRow {
  fingerprint: string;
  title: string | null;
  severity: string | null;
  occurrences: number;
  repos: number;
  last_seen: string;
}

export interface HealthCounts {
  repos: number;
  prs: number;
  reviews: number;
  findings: number;
  issues: number;
  events: number;
  pattern_hits: number;
  db_bytes: number | null;
  oldest_review: string | null;
  newest_review: string | null;
}

export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
  raw: string;
}

export interface PatternRuleRow {
  owner: string;
  repo: string;
  rule_name: string;
  source: string;
  hits_total: number;
  hits_30d: number;
  last_hit: string | null;
}

// ─── Endpoint response payloads (the `data` of each envelope) ────────

export type Role = "viewer" | "author" | "admin";

export interface Capabilities {
  viewDashboard: boolean;
  triageFindings: boolean;
  triggerReview: boolean;
  manageConfig: boolean;
  manageRoles: boolean;
  viewAudit: boolean;
}

export interface MeResponse {
  user: { login: string; id: number; role: Role; capabilities: Capabilities };
  authEnabled: boolean;
}

export interface AuditLogRow {
  id: number;
  ts: string;
  actor_login: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_ref: string | null;
  payload_json: string | null;
  result: string | null;
}

export interface RoleOverrideRow {
  login: string;
  role: string;
  granted_by: string | null;
  granted_at: string | null;
}

export interface AuditResponse {
  rows: AuditLogRow[];
  total: number;
  actions: string[];
  roles: RoleOverrideRow[];
}

export interface HealthResponse {
  counts: HealthCounts;
  logs: LogEntry[];
}

export interface ReposResponse {
  repos: RepoOverviewRow[];
  activity: DailyActivityRow[];
}

export interface RepoDetailResponse {
  owner: string;
  repo: string;
  sparkline: SparklinePoint[];
  hotPaths: HotPathRow[];
  topRules: RuleHitRow[];
  prs: RecentPRRow[];
  issues: IssueRow[];
  activity: DailyActivityRow[];
  approvalMix: ApprovalMixRow[];
  learnings: Learning[];
  config: string | null;
}

export interface PRDetailResponse {
  owner: string;
  repo: string;
  number: number;
  pr: PRRow | null;
  reviews: PRReviewRow[];
  latest: PRReviewRow | null;
  findings: PRFindingRow[];
  events: EventRow[];
}

export interface FindingsResponse {
  rows: FindingExplorerRow[];
  total: number;
  groups: FingerprintGroupRow[];
  filters: FindingFilters;
}

export interface PatternsResponse {
  rules: PatternRuleRow[];
}

// ─── Diagnostics / first-run experience ─────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckCategory = "github" | "ai" | "auth" | "persistence";

export interface DiagnosticCheck {
  id: string;
  category: CheckCategory;
  label: string;
  status: CheckStatus;
  detail: string;
  fixHint?: string;
}

export interface DiagnosticsResponse {
  checks: DiagnosticCheck[];
  summary: { ok: number; warn: number; fail: number };
  /** True when at least one check failed — drives the setup wizard. */
  incomplete: boolean;
  config: {
    provider: string;
    model: string;
    botName: string;
    authEnabled: boolean;
    oauthConfigured: boolean;
    dashboardUrl: string | null;
    persistence: boolean;
  };
  db: {
    enabled: boolean;
    sizeBytes: number | null;
    lastReviewAt: string | null;
    counts: HealthCounts;
  };
}

export interface InstallationInfo {
  id: number;
  account: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  repos: string[];
  repoCount: number;
  truncated: boolean;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  action: string | null;
  status: string;
  statusCode: number;
  deliveredAt: string;
  redelivery: boolean;
}

export interface GithubDiagnosticsResponse {
  app: { slug: string | null; name: string | null; htmlUrl: string | null } | null;
  installations: InstallationInfo[];
  webhook: { configuredUrl: string | null; deliveries: WebhookDelivery[]; error?: string };
  rateLimit: { limit: number; remaining: number; reset: string } | null;
  error?: string;
  reachable: boolean;
  connectedRepos: number;
  installationCount: number;
}

export interface TestAiResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export interface TestWebhookResult {
  ok: boolean;
  error?: string;
  secretConfigured: boolean;
}

// ─── Impact report (mirror ImpactReport in src/dashboard/queries.ts) ──

export interface ImpactDayBin {
  day: string;
  reviews: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
}

export interface ImpactWindow {
  reviews: number;
  prsCovered: number;
  mergedPrsCovered: number;
  repos: number;
  findings: number;
  bySeverity: { critical: number; major: number; minor: number; nit: number };
  mergedBySeverity: { critical: number; major: number; minor: number; nit: number };
  criticalMajorCaughtBeforeMerge: number;
  accepted: number;
  dismissed: number;
  pending: number;
  acceptanceRate: number | null;
  timeSavedMinutes: number;
}

export interface ImpactRecurring {
  distinctFingerprints: number;
  totalOccurrences: number;
  repeatsPrevented: number;
  firstHalf: number;
  secondHalf: number;
}

export interface ImpactReport {
  range: { days: number | null; label: string; since: string | null; until: string };
  repo: string | null;
  minutesPerFinding: number;
  current: ImpactWindow;
  previous: ImpactWindow | null;
  recurring: ImpactRecurring;
  trend: ImpactDayBin[];
  generatedAt: string;
}

// ─── Review queue board (mirror src/realtime/bus.ts) ─────────────────

export type ReviewQueueState = "queued" | "running" | "done" | "failed" | "canceled";

export interface ReviewQueueEntry {
  key: string;
  owner: string;
  repo: string;
  number: number;
  mode: "full" | "incremental";
  state: ReviewQueueState;
  phase: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  attempt: number;
}

export interface QueueResponse {
  entries: ReviewQueueEntry[];
}

// ─── Webhook deliveries (mirror src/dashboard/queries.ts) ────────────

export interface WebhookDeliveryRow {
  id: number;
  ts: string;
  event: string | null;
  action: string | null;
  owner: string | null;
  repo: string | null;
  number: number | null;
  delivery_id: string | null;
  signature_ok: number | null;
  replayed_from: number | null;
  payload_bytes: number | null;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryRow {
  payload_json: string | null;
}

export interface WebhooksResponse {
  rows: WebhookDeliveryRow[];
  total: number;
  events: string[];
  repos: string[];
}

export interface ReplayResponse {
  id: number;
  newDeliveryId: number | null;
  event: string | null;
  dispatchStatus: number;
  result: string;
}

// ─── Search (Cmd-K palette) ─────────────────────────────────────────

export type SearchResultType = "repo" | "pr" | "finding" | "learning";

export interface SearchResult {
  type: SearchResultType;
  title: string;
  subtitle: string | null;
  /** SPA client-side route to navigate to on Enter. */
  to: string;
  owner: string;
  repo: string;
  number: number | null;
  severity: string | null;
  score: number;
}

export interface SearchResponse {
  q: string;
  results: SearchResult[];
}
