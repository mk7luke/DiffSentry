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
