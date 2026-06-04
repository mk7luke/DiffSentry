// Shared API types — hand-mirrored from the row interfaces in
// src/dashboard/queries.ts and src/logger.ts. Keep in sync with the backend;
// the JSON API returns these shapes verbatim inside a { data } envelope.

export type Severity = "critical" | "major" | "minor" | "nit";

/** The three triage decisions a user can apply to a finding. */
export type TriageState = "accepted" | "dismissed" | "snoozed";

/** Triage columns shared by explorer + PR finding rows (mirror queries.ts). */
export interface TriageColumns {
  accepted: number | null; // 1 = accepted, 0 = dismissed, null = undecided
  snoozed_until: string | null;
  triaged_by: string | null;
  triaged_at: string | null;
  triage_note: string | null;
}

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

export interface PRFindingRow extends TriageColumns {
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

export interface FindingExplorerRow extends TriageColumns {
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
  triage?: string;
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

export interface RecurringFindingRow {
  fingerprint: string;
  title: string | null;
  severity: string | null;
  occurrences: number;
  repos: number;
  prs: number;
  first_seen: string;
  last_seen: string;
  accepted_count: number;
  dismissed_count: number;
  snoozed_count: number;
  untriaged_count: number;
}

export interface RecurringResponse {
  rows: RecurringFindingRow[];
  filters: FindingFilters;
}

/** Server response from a triage write (single or bulk). */
export interface TriageResult {
  id?: number;
  requested?: number;
  /** Bulk only — how many of the requested ids matched existing findings. */
  matched?: number;
  changed: number;
  state: TriageState;
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
  manageLearnings: boolean;
  manageConfig: boolean;
  manageRoles: boolean;
  viewAudit: boolean;
  manageNotifications: boolean;
  manageTokens: boolean;
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

// ─── Notifications ──────────────────────────────────────────────────

export type ChannelType = "slack" | "discord" | "webhook" | "email";
export type AlertEventType = "finding" | "review_failed" | "budget" | "digest" | "any";

export interface NotificationChannel {
  id: number;
  type: ChannelType;
  name: string | null;
  enabled: boolean;
  /** Redacted config — secrets are masked server-side. */
  config: Record<string, unknown>;
  created_by: string | null;
  created_at: string | null;
}

export interface AlertRuleCondition {
  event: AlertEventType;
  minSeverity?: Severity;
}

export interface AlertRule {
  id: number;
  name: string | null;
  scope: string | null;
  condition: AlertRuleCondition;
  channel_id: number | null;
  enabled: boolean;
  created_by: string | null;
  created_at: string | null;
}

export interface NotificationDeliveryRow {
  id: number;
  ts: string;
  channel_id: number | null;
  channel_type: string | null;
  channel_name: string | null;
  rule_id: number | null;
  rule_name: string | null;
  trigger: string | null;
  target: string | null;
  title: string | null;
  status: string;
  detail: string | null;
}

export interface NotificationsResponse {
  channels: NotificationChannel[];
  rules: AlertRule[];
  deliveries: NotificationDeliveryRow[];
  channelTypes: ChannelType[];
  eventTypes: AlertEventType[];
}

/** Resolved instance branding (admin override → env → built-in default). */
export interface BrandingResponse {
  instanceName: string;
  accentColor: string;
}

/** Branding write payload. Omit a field to leave it unchanged; send null/"" to
 * clear that override and revert to the env / built-in default. */
export interface BrandingUpdate {
  instanceName?: string | null;
  accentColor?: string | null;
}

// ─── Cost / AI spend ─────────────────────────────────────────────────

export interface CostTotals {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

export interface CostGroupRow {
  key: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

export interface CostDailyModelRow {
  day: string; // YYYY-MM-DD
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface BudgetView {
  scope: string; // 'global' | 'owner/repo'
  monthlyUsd: number;
  spentUsd: number;
  pct: number;
  exceeded: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CostResponse {
  range: string;
  since: string | null;
  group: string | null;
  totals: CostTotals;
  monthToDate: number;
  projectedMonthEnd: number;
  dayOfMonth: number;
  daysInMonth: number;
  byModel: CostGroupRow[];
  byRepo: CostGroupRow[];
  byKind: CostGroupRow[];
  daily: CostDailyModelRow[];
  models: string[];
  budgets: BudgetView[];
  grouped?: CostGroupRow[];
}

// ─── Settings (operator controls) ───────────────────────────────────

export type Profile = "chill" | "assertive";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface GlobalSettings {
  pauseAll: boolean;
  autoReview: boolean;
  defaultProfile: Profile;
  logLevel: LogLevel;
  /** null = use the MAX_FILES_PER_REVIEW env default. */
  maxFiles: number | null;
}

export interface SettingsResponse {
  settings: GlobalSettings;
}

/** Per-repo overrides; null on a field means "inherit the global value". */
export interface RepoSettings {
  autoReview: boolean | null;
  profile: Profile | null;
  maxFiles: number | null;
}

export interface RepoSettingsResponse {
  owner: string;
  repo: string;
  settings: RepoSettings;
}

/** Body for PUT /settings — any subset of keys; null clears a clearable one. */
export interface GlobalSettingsPatch {
  pauseAll?: boolean;
  autoReview?: boolean;
  defaultProfile?: Profile;
  logLevel?: LogLevel;
  maxFiles?: number | null;
}

/** Body for PUT /repos/:owner/:repo/settings. null clears (inherit global). */
export interface RepoSettingsPatch {
  autoReview?: boolean | null;
  profile?: Profile | null;
  maxFiles?: number | null;
}

// ─── API tokens (platform) ──────────────────────────────────────────

export type ApiScope = "read" | "review";

/** Token metadata — never includes the secret. */
export interface ApiTokenMeta {
  id: number;
  name: string | null;
  scopes: ApiScope[];
  created_by: string | null;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface TokensResponse {
  tokens: ApiTokenMeta[];
  availableScopes: ApiScope[];
}

/** Returned once by POST /tokens — `token` is the plaintext secret. */
export interface CreatedToken {
  id: number;
  name: string;
  scopes: ApiScope[];
  token: string;
}

// ─── Custom rules (admin-authored anti-patterns) ────────────────────

export type RuleSeverity = "critical" | "major" | "minor" | "trivial";
export type RuleType = "issue" | "suggestion" | "nitpick" | "documentation" | "security";

/** A custom_rules row + its pattern-hit counts (mirrors CustomRuleWithHits). */
export interface CustomRuleRow {
  id: number;
  scope: string;
  kind: string;
  name: string;
  severity: RuleSeverity;
  type: RuleType;
  pattern: string;
  flags: string | null;
  path_glob: string | null;
  message: string | null;
  advice: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  hits_total: number;
  hits_30d: number;
  last_hit: string | null;
}

export interface CustomRulesResponse {
  rules: CustomRuleRow[];
}

/** Body for create/update. Server applies defaults for omitted optionals. */
export interface CustomRuleInput {
  name: string;
  pattern: string;
  scope?: string;
  kind?: string;
  severity?: RuleSeverity;
  type?: RuleType;
  flags?: string | null;
  pathGlob?: string | null;
  message?: string | null;
  advice?: string | null;
  enabled?: boolean;
}

export interface RuleTestMatch {
  line: number;
  text: string;
  match: string;
}

/** Result of POST /rules/test — compile status + per-line matches. */
export interface RuleTestResult {
  ok: boolean;
  error?: string;
  applies: boolean;
  matches: RuleTestMatch[];
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

// ─── Repo config editor (mirrors src/config-schema.ts) ──────────────

export interface JsonSchema {
  type?: "object" | "array" | "string" | "boolean" | "number" | "integer";
  enum?: (string | number)[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  description?: string;
  widget?: "glob" | "multiline" | "regex";
}

export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface RepoConfigResponse {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  /** Raw .diffsentry.yaml on the default branch, or null when absent. */
  yaml: string | null;
  exists: boolean;
  /** Parsed config object (the as-authored values, not merged). */
  parsed: Record<string, unknown>;
  /** Non-null when the stored YAML failed to parse. */
  parseError: string | null;
  /** Parsed config merged with DiffSentry's defaults. */
  effective: Record<string, unknown>;
  schema: JsonSchema;
  /** True when the server can commit (octokit + installation present). */
  editable: boolean;
}

export interface ConfigUpdateResult {
  owner: string;
  repo: string;
  mode: "commit" | "pr";
  branch: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
}

// ─── Analytics: authors & trends ────────────────────────────────────

export interface AuthorStatRow {
  author: string;
  prs_reviewed: number;
  reviews: number;
  avg_risk: number | null;
  findings: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
  triaged: number;
  accepted: number;
}

export interface AuthorDayRow {
  author: string;
  day: string; // YYYY-MM-DD
  reviews: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
}

export interface AuthorPRRow {
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  latest_at: string;
  review_count: number;
  latest_approval: string | null;
  latest_risk_score: number | null;
  latest_risk_level: string | null;
  total_findings: number;
}

export interface RiskBucketRow {
  level: string; // low | moderate | elevated | high | critical | unscored
  count: number;
}

export interface HotPathTrendPoint {
  path: string;
  day: string; // YYYY-MM-DD
  critical: number;
  major: number;
  total: number;
}

export interface AuthorsResponse {
  days: number;
  authors: AuthorStatRow[];
  series: AuthorDayRow[];
}

export interface AuthorDetailResponse {
  author: string;
  days: number;
  stat: AuthorStatRow | null;
  series: AuthorDayRow[];
  hotPaths: HotPathRow[];
  prs: AuthorPRRow[];
}

export interface TrendsResponse {
  days: number;
  activity: DailyActivityRow[];
  riskDistribution: RiskBucketRow[];
  hotPaths: HotPathRow[];
  hotPathSeries: HotPathTrendPoint[];
}

// ─── Learnings management ────────────────────────────────────────────

export type LearningScope = "global" | "repo";

export interface RepoLearnings {
  owner: string;
  repo: string;
  learnings: Learning[];
}

/** A learning flattened across scopes, as returned inside dedupe groups and the
 * path-test response. `owner`/`repo` are present only for repo-scoped entries. */
export interface FlatLearning {
  scope: LearningScope;
  owner?: string;
  repo?: string;
  id: string;
  content: string;
  path?: string;
}

export interface DuplicateGroup {
  members: FlatLearning[];
}

export interface LearningsResponse {
  global: Learning[];
  repos: RepoLearnings[];
  duplicates: DuplicateGroup[];
}

export interface LearningTestResponse {
  path: string;
  matched: FlatLearning[];
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
