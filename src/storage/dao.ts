import { openDatabase } from "./db.js";
import type { IssueContext, PRContext, ReviewComment, ReviewResult } from "../types.js";
import type { RiskAssessment } from "../insights.js";
import { logger } from "../logger.js";

/** Best-effort upsert of a (owner, repo) row. */
export function recordRepo(opts: {
  owner: string;
  repo: string;
  installationId: number;
}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO repos (owner, repo, installation_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo) DO UPDATE SET
         installation_id = excluded.installation_id,
         last_seen = excluded.last_seen`,
    ).run(opts.owner, opts.repo, opts.installationId, now, now);
  } catch (err) {
    logger.debug({ err }, "dao.recordRepo failed");
  }
}

/** Upsert a PR row. */
export function recordPR(ctx: PRContext, extras: { state?: string; closedAt?: string | null; mergedAt?: string | null } = {}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO prs (owner, repo, number, title, author, state, base_sha, head_sha, created_at, closed_at, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo, number) DO UPDATE SET
         title = excluded.title,
         author = excluded.author,
         state = excluded.state,
         base_sha = excluded.base_sha,
         head_sha = excluded.head_sha,
         closed_at = excluded.closed_at,
         merged_at = excluded.merged_at`,
    ).run(
      ctx.owner,
      ctx.repo,
      ctx.pullNumber,
      ctx.title,
      ctx.author ?? null,
      extras.state ?? null,
      ctx.baseSha ?? null,
      ctx.headSha,
      new Date().toISOString(),
      extras.closedAt ?? null,
      extras.mergedAt ?? null,
    );
  } catch (err) {
    logger.debug({ err }, "dao.recordPR failed");
  }
}

/** Insert a review row, return its rowid. Returns null when persistence is disabled. */
export function recordReview(opts: {
  ctx: PRContext;
  result: ReviewResult;
  risk?: RiskAssessment;
  profile: string;
  filesProcessed: number;
  filesSkippedSimilar: number;
  filesSkippedTrivial: number;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  try {
    const info = db.prepare(
      `INSERT INTO reviews (owner, repo, number, sha, profile, approval, summary, risk_score, risk_level,
                            files_processed, files_skipped_similar, files_skipped_trivial, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.ctx.owner,
      opts.ctx.repo,
      opts.ctx.pullNumber,
      opts.ctx.headSha,
      opts.profile,
      opts.result.approval,
      opts.result.summary?.slice(0, 50_000) ?? null,
      opts.risk?.score ?? null,
      opts.risk?.level ?? null,
      opts.filesProcessed,
      opts.filesSkippedSimilar,
      opts.filesSkippedTrivial,
      new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.recordReview failed");
    return null;
  }
}

/** Bulk insert findings for a review. */
export function recordFindings(reviewId: number, comments: ReviewComment[], sourceFor: (c: ReviewComment) => "ai" | "safety" | "builtin" | "custom" = () => "ai"): void {
  const db = openDatabase();
  if (!db || comments.length === 0) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO findings (review_id, path, line, type, severity, title, body, fingerprint, source, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = db.transaction((rows: ReviewComment[]) => {
      for (const c of rows) {
        stmt.run(
          reviewId,
          c.path ?? null,
          c.line ?? null,
          c.type ?? null,
          c.severity ?? null,
          c.title ?? null,
          (c.body ?? "").slice(0, 50_000),
          c.fingerprint ?? null,
          sourceFor(c),
          c.confidence ?? null,
        );
      }
    });
    insertMany(comments);
  } catch (err) {
    logger.debug({ err }, "dao.recordFindings failed");
  }
}

/** Append an event row. */
export function recordEvent(opts: {
  owner: string;
  repo: string;
  number?: number | null;
  kind: string;
  payload?: unknown;
}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.owner,
      opts.repo,
      opts.number ?? null,
      new Date().toISOString(),
      opts.kind,
      opts.payload === undefined ? null : JSON.stringify(opts.payload).slice(0, 100_000),
    );
  } catch (err) {
    logger.debug({ err }, "dao.recordEvent failed");
  }
}

/**
 * Upsert an issue row from a fetched IssueContext. Updates volatile fields
 * (state, body, comment count, labels) on conflict but never overwrites the
 * `first_seen_at` we stamped on initial contact, and never clears any
 * action history columns.
 */
export function recordIssue(ctx: IssueContext, opts: { createdAt?: string | null } = {}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO issues (
         owner, repo, number, title, author, state, body, url, labels_json,
         comment_count, created_at, first_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo, number) DO UPDATE SET
         title = excluded.title,
         author = excluded.author,
         state = excluded.state,
         body = excluded.body,
         url = excluded.url,
         labels_json = excluded.labels_json,
         comment_count = excluded.comment_count,
         created_at = COALESCE(issues.created_at, excluded.created_at)`,
    ).run(
      ctx.owner,
      ctx.repo,
      ctx.issueNumber,
      ctx.title,
      ctx.author ?? null,
      ctx.state ?? null,
      (ctx.body ?? "").slice(0, 50_000),
      ctx.url ?? null,
      JSON.stringify(ctx.labels ?? []),
      ctx.comments?.length ?? 0,
      opts.createdAt ?? null,
      now,
    );
  } catch (err) {
    logger.debug({ err }, "dao.recordIssue failed");
  }
}

/**
 * Mark an action that DiffSentry took on an issue (auto-summary,
 * regenerated summary, plan, chat reply, learning saved, etc.). Bumps
 * action_count, updates last_action_*, optionally captures the latest
 * summary/plan text, and writes an event row prefixed `issue.*` for the
 * timeline.
 */
export function recordIssueAction(opts: {
  owner: string;
  repo: string;
  number: number;
  /** Bare action name, e.g. "auto_summary", "summary_regen", "plan", "chat", "learn", "paused", "resumed". */
  action: string;
  /** When provided, replaces issues.last_summary so the dashboard can render it. */
  summary?: string | null;
  /** When provided, replaces issues.last_plan. */
  plan?: string | null;
  /** Optional payload stored on the corresponding event row. */
  payload?: unknown;
}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE issues
         SET last_action_at = ?,
             last_action_kind = ?,
             action_count = action_count + 1,
             last_summary = COALESCE(?, last_summary),
             last_plan = COALESCE(?, last_plan)
       WHERE owner = ? AND repo = ? AND number = ?`,
    ).run(
      now,
      opts.action,
      opts.summary != null ? opts.summary.slice(0, 50_000) : null,
      opts.plan != null ? opts.plan.slice(0, 50_000) : null,
      opts.owner,
      opts.repo,
      opts.number,
    );
    db.prepare(
      `INSERT INTO events (owner, repo, number, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.owner,
      opts.repo,
      opts.number,
      now,
      `issue.${opts.action}`,
      opts.payload === undefined ? null : JSON.stringify(opts.payload).slice(0, 100_000),
    );
  } catch (err) {
    logger.debug({ err }, "dao.recordIssueAction failed");
  }
}

/** Bulk insert pattern hits — every pattern-checks / safety-scanner finding. */
export function recordPatternHits(opts: {
  owner: string;
  repo: string;
  reviewId: number | null;
  hits: Array<{ ruleName: string; source: "builtin" | "custom" | "safety"; fingerprint?: string }>;
}): void {
  const db = openDatabase();
  if (!db || opts.hits.length === 0) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: typeof opts.hits) => {
      for (const r of rows) {
        stmt.run(opts.owner, opts.repo, r.ruleName, r.source, r.fingerprint ?? null, opts.reviewId);
      }
    });
    tx(opts.hits);
  } catch (err) {
    logger.debug({ err }, "dao.recordPatternHits failed");
  }
}
