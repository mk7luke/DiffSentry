import { openDatabase } from "../storage/db.js";

export interface RepoOverviewRow {
  owner: string;
  repo: string;
  prs_reviewed: number;
  findings_7d: number;
  critical_7d: number;
  last_review: string | null;
}

/** Repos + activity stats for the overview table. */
export function getRepoOverview(): RepoOverviewRow[] {
  const db = openDatabase();
  if (!db) return [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT
         r.owner,
         r.repo,
         (SELECT COUNT(DISTINCT number) FROM reviews rv WHERE rv.owner = r.owner AND rv.repo = r.repo) AS prs_reviewed,
         (SELECT COUNT(*) FROM findings f
            JOIN reviews rv ON rv.id = f.review_id
            WHERE rv.owner = r.owner AND rv.repo = r.repo AND rv.created_at >= ?) AS findings_7d,
         (SELECT COUNT(*) FROM findings f
            JOIN reviews rv ON rv.id = f.review_id
            WHERE rv.owner = r.owner AND rv.repo = r.repo AND rv.created_at >= ? AND f.severity = 'critical') AS critical_7d,
         (SELECT MAX(created_at) FROM reviews rv WHERE rv.owner = r.owner AND rv.repo = r.repo) AS last_review
       FROM repos r
       ORDER BY (last_review IS NULL), last_review DESC`,
    )
    .all(sevenDaysAgo, sevenDaysAgo) as RepoOverviewRow[];
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

export interface RecentReviewRow {
  id: number;
  number: number;
  created_at: string;
  sha: string;
  approval: string | null;
  risk_score: number | null;
  risk_level: string | null;
  finding_count: number;
  title: string | null;
  author: string | null;
}

/** Look up the most recent installation id for a repo, or null. */
export function getInstallationId(owner: string, repo: string): number | null {
  const db = openDatabase();
  if (!db) return null;
  const row = db
    .prepare(`SELECT installation_id FROM repos WHERE owner = ? AND repo = ? LIMIT 1`)
    .get(owner, repo) as { installation_id?: number } | undefined;
  return row?.installation_id ?? null;
}

/** Is this (owner, repo) known? */
export function repoExists(owner: string, repo: string): boolean {
  const db = openDatabase();
  if (!db) return false;
  const row = db.prepare(`SELECT 1 FROM repos WHERE owner = ? AND repo = ? LIMIT 1`).get(owner, repo);
  return !!row;
}

/** Last 90 days of reviews for the sparkline. */
export function getSparkline(owner: string, repo: string): SparklinePoint[] {
  const db = openDatabase();
  if (!db) return [];
  const ninety = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT created_at, risk_score, number
       FROM reviews
       WHERE owner = ? AND repo = ? AND created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(owner, repo, ninety) as SparklinePoint[];
}

/** Top 10 hottest paths by critical+major findings, last 90d. */
export function getHotPaths(owner: string, repo: string): HotPathRow[] {
  const db = openDatabase();
  if (!db) return [];
  const ninety = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT
         f.path AS path,
         SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
         SUM(CASE WHEN f.severity = 'major' THEN 1 ELSE 0 END) AS major,
         COUNT(*) AS total
       FROM findings f
       JOIN reviews rv ON rv.id = f.review_id
       WHERE rv.owner = ? AND rv.repo = ? AND rv.created_at >= ? AND f.path IS NOT NULL
       GROUP BY f.path
       HAVING (critical + major) > 0
       ORDER BY critical DESC, major DESC, total DESC
       LIMIT 10`,
    )
    .all(owner, repo, ninety) as HotPathRow[];
}

/** Top 10 firing pattern rules (all time) with counts + one example PR. */
export function getTopRules(owner: string, repo: string): RuleHitRow[] {
  const db = openDatabase();
  if (!db) return [];
  return db
    .prepare(
      `SELECT
         ph.rule_name,
         ph.source,
         COUNT(*) AS hits,
         (SELECT rv.number FROM pattern_hits ph2
            JOIN reviews rv ON rv.id = ph2.review_id
            WHERE ph2.owner = ph.owner AND ph2.repo = ph.repo AND ph2.rule_name = ph.rule_name
            ORDER BY rv.created_at DESC LIMIT 1) AS example_pr
       FROM pattern_hits ph
       WHERE ph.owner = ? AND ph.repo = ?
       GROUP BY ph.rule_name, ph.source
       ORDER BY hits DESC
       LIMIT 10`,
    )
    .all(owner, repo) as RuleHitRow[];
}

/** Last 50 reviews for a repo, with PR title + author + finding count. */
export function getRecentReviews(owner: string, repo: string, limit = 50): RecentReviewRow[] {
  const db = openDatabase();
  if (!db) return [];
  return db
    .prepare(
      `SELECT
         rv.id, rv.number, rv.created_at, rv.sha, rv.approval, rv.risk_score, rv.risk_level,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = rv.id) AS finding_count,
         p.title, p.author
       FROM reviews rv
       LEFT JOIN prs p ON p.owner = rv.owner AND p.repo = rv.repo AND p.number = rv.number
       WHERE rv.owner = ? AND rv.repo = ?
       ORDER BY rv.created_at DESC
       LIMIT ?`,
    )
    .all(owner, repo, limit) as RecentReviewRow[];
}

// ─── PR detail ──────────────────────────────────────────────────────

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

export interface FindingRow {
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
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  payload_json: string | null;
}

export function getPR(owner: string, repo: string, number: number): PRRow | null {
  const db = openDatabase();
  if (!db) return null;
  const row = db
    .prepare(`SELECT owner, repo, number, title, author, state, head_sha, base_sha, created_at FROM prs WHERE owner = ? AND repo = ? AND number = ?`)
    .get(owner, repo, number) as PRRow | undefined;
  return row ?? null;
}

export function getPRReviews(owner: string, repo: string, number: number): PRReviewRow[] {
  const db = openDatabase();
  if (!db) return [];
  return db
    .prepare(
      `SELECT rv.id, rv.created_at, rv.sha, rv.profile, rv.approval, rv.summary,
              rv.risk_score, rv.risk_level, rv.files_processed, rv.files_skipped_similar, rv.files_skipped_trivial,
              (SELECT COUNT(*) FROM findings f WHERE f.review_id = rv.id) AS finding_count
       FROM reviews rv
       WHERE rv.owner = ? AND rv.repo = ? AND rv.number = ?
       ORDER BY rv.created_at DESC`,
    )
    .all(owner, repo, number) as PRReviewRow[];
}

export function getFindings(reviewId: number): FindingRow[] {
  const db = openDatabase();
  if (!db) return [];
  return db
    .prepare(
      `SELECT id, path, line, type, severity, title, body, fingerprint, source, confidence
       FROM findings
       WHERE review_id = ?
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'major' THEN 1
           WHEN 'minor' THEN 2
           WHEN 'nit' THEN 3
           ELSE 4
         END ASC,
         path ASC, line ASC`,
    )
    .all(reviewId) as FindingRow[];
}

// ─── Findings explorer ─────────────────────────────────────────────

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
  repo?: string; // "owner/repo"
  q?: string; // substring on path + title
  fingerprint?: string;
  ageDays?: number; // only findings from reviews created within N days
  limit?: number;
  offset?: number;
}

export interface FindingExplorerResult {
  rows: FindingExplorerRow[];
  total: number;
}

function buildFindingsWhere(f: FindingFilters): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.severity) {
    clauses.push("fi.severity = ?");
    params.push(f.severity);
  }
  if (f.source) {
    clauses.push("fi.source = ?");
    params.push(f.source);
  }
  if (f.repo && f.repo.includes("/")) {
    const [o, r] = f.repo.split("/", 2);
    clauses.push("rv.owner = ? AND rv.repo = ?");
    params.push(o, r);
  }
  if (f.fingerprint) {
    clauses.push("fi.fingerprint = ?");
    params.push(f.fingerprint);
  }
  if (f.q) {
    clauses.push("(COALESCE(fi.path,'') LIKE ? OR COALESCE(fi.title,'') LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like);
  }
  if (typeof f.ageDays === "number" && f.ageDays > 0) {
    const cutoff = new Date(Date.now() - f.ageDays * 24 * 60 * 60 * 1000).toISOString();
    clauses.push("rv.created_at >= ?");
    params.push(cutoff);
  }
  const clause = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return { clause, params };
}

export function queryFindings(filters: FindingFilters): FindingExplorerResult {
  const db = openDatabase();
  if (!db) return { rows: [], total: 0 };
  const { clause, params } = buildFindingsWhere(filters);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM findings fi JOIN reviews rv ON rv.id = fi.review_id ${clause}`)
    .get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT fi.id, rv.owner, rv.repo, rv.number, rv.created_at,
              fi.path, fi.line, fi.severity, fi.title, fi.source, fi.fingerprint, fi.type
       FROM findings fi
       JOIN reviews rv ON rv.id = fi.review_id
       ${clause}
       ORDER BY rv.created_at DESC, fi.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as FindingExplorerRow[];
  return { rows, total };
}

export interface FingerprintGroupRow {
  fingerprint: string;
  title: string | null;
  severity: string | null;
  occurrences: number;
  repos: number;
  last_seen: string;
}

/** Group findings by fingerprint — "this finding raised on N PRs". */
export function queryFingerprintGroups(filters: FindingFilters, limit = 50): FingerprintGroupRow[] {
  const db = openDatabase();
  if (!db) return [];
  const { clause, params } = buildFindingsWhere(filters);
  return db
    .prepare(
      `SELECT fi.fingerprint,
              MAX(fi.title) AS title,
              MAX(fi.severity) AS severity,
              COUNT(*) AS occurrences,
              COUNT(DISTINCT rv.owner || '/' || rv.repo) AS repos,
              MAX(rv.created_at) AS last_seen
       FROM findings fi
       JOIN reviews rv ON rv.id = fi.review_id
       ${clause ? clause + " AND " : "WHERE "} fi.fingerprint IS NOT NULL AND fi.fingerprint <> ''
       GROUP BY fi.fingerprint
       HAVING occurrences >= 2
       ORDER BY occurrences DESC, last_seen DESC
       LIMIT ?`,
    )
    .all(...params, limit) as FingerprintGroupRow[];
}

export function getEvents(owner: string, repo: string, number: number, limit = 100): EventRow[] {
  const db = openDatabase();
  if (!db) return [];
  return db
    .prepare(
      `SELECT id, ts, kind, payload_json
       FROM events
       WHERE owner = ? AND repo = ? AND number = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(owner, repo, number, limit) as EventRow[];
}

// ─── Settings / health ─────────────────────────────────────────────

export interface HealthCounts {
  repos: number;
  prs: number;
  reviews: number;
  findings: number;
  events: number;
  pattern_hits: number;
  db_bytes: number | null;
  oldest_review: string | null;
  newest_review: string | null;
}

export function getHealthCounts(): HealthCounts {
  const db = openDatabase();
  if (!db) {
    return {
      repos: 0, prs: 0, reviews: 0, findings: 0, events: 0, pattern_hits: 0,
      db_bytes: null, oldest_review: null, newest_review: null,
    };
  }
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let dbBytes: number | null = null;
  try {
    const row = db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get() as { bytes?: number };
    dbBytes = row?.bytes ?? null;
  } catch {
    // ignore — older SQLite may not expose pragma_* as tables
  }
  const range = db.prepare("SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM reviews").get() as { mn: string | null; mx: string | null };
  return {
    repos: one("SELECT COUNT(*) AS n FROM repos"),
    prs: one("SELECT COUNT(*) AS n FROM prs"),
    reviews: one("SELECT COUNT(*) AS n FROM reviews"),
    findings: one("SELECT COUNT(*) AS n FROM findings"),
    events: one("SELECT COUNT(*) AS n FROM events"),
    pattern_hits: one("SELECT COUNT(*) AS n FROM pattern_hits"),
    db_bytes: dbBytes,
    oldest_review: range.mn,
    newest_review: range.mx,
  };
}

// ─── Pattern analytics ─────────────────────────────────────────────

export interface PatternRuleRow {
  owner: string;
  repo: string;
  rule_name: string;
  source: string;
  hits_total: number;
  hits_30d: number;
  last_hit: string | null;
}

export function getPatternRules(limit = 100): PatternRuleRow[] {
  const db = openDatabase();
  if (!db) return [];
  const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT ph.owner, ph.repo, ph.rule_name, ph.source,
              COUNT(*) AS hits_total,
              SUM(CASE WHEN rv.created_at >= ? THEN 1 ELSE 0 END) AS hits_30d,
              MAX(rv.created_at) AS last_hit
       FROM pattern_hits ph
       LEFT JOIN reviews rv ON rv.id = ph.review_id
       GROUP BY ph.owner, ph.repo, ph.rule_name, ph.source
       ORDER BY hits_30d DESC, hits_total DESC
       LIMIT ?`,
    )
    .all(thirty, limit) as PatternRuleRow[];
}
