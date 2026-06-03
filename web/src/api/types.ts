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

export interface MeResponse {
  user: { login: string; id: number; role: Role };
  authEnabled: boolean;
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
