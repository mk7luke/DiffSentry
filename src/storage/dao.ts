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

// ---------------------------------------------------------------------------
// Command-center writes (schema v2). All best-effort no-ops when the DB is
// disabled, matching the helpers above. Reads/queries for the dashboard live
// in src/dashboard/queries.ts; these are the mutating helpers other worktrees
// (API routes, alerting, cost tracking) compose on top of.
// ---------------------------------------------------------------------------

/**
 * Best-effort JSON serialization for optional payload columns. Returns `null`
 * instead of throwing whenever the value can't be represented as JSON —
 * `undefined`, an unsupported top-level value (function/symbol), a circular
 * structure, or a `BigInt` — so the surrounding row is still inserted with a
 * NULL payload rather than being lost to the catch block.
 */
function safeJsonStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    // Top-level function/symbol/undefined yield undefined; circular and BigInt throw.
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * Append an audit_log row. Every role-gated write endpoint must call this.
 * Returns the new rowid, or null when persistence is disabled.
 */
export function insertAuditLog(opts: {
  actorLogin?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetRef?: string | null;
  payload?: unknown;
  result?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  try {
    const payloadJson = safeJsonStringify(opts.payload);
    const info = db.prepare(
      `INSERT INTO audit_log (ts, actor_login, actor_role, action, target_type, target_ref, payload_json, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      opts.actorLogin ?? null,
      opts.actorRole ?? null,
      opts.action,
      opts.targetType ?? null,
      opts.targetRef ?? null,
      payloadJson == null ? null : payloadJson.slice(0, 100_000),
      opts.result ?? null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.insertAuditLog failed");
    return null;
  }
}

/**
 * Upsert a settings override. `scope` is 'global' or 'owner/repo'. `value` is
 * JSON-serialized before storage.
 */
export function upsertSettingOverride(opts: {
  scope: string;
  key: string;
  value: unknown;
  updatedBy?: string | null;
}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    // Settings overrides are meaningful config (not best-effort logs), so an
    // unrepresentable value is rejected rather than silently coerced to null.
    const valueJson = safeJsonStringify(opts.value);
    if (valueJson == null) {
      logger.debug(
        { scope: opts.scope, key: opts.key },
        "dao.upsertSettingOverride: value not JSON-serializable — skipping write",
      );
      return;
    }
    db.prepare(
      `INSERT INTO settings_overrides (scope, key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(
      opts.scope,
      opts.key,
      valueJson,
      opts.updatedBy ?? null,
      new Date().toISOString(),
    );
  } catch (err) {
    logger.debug({ err }, "dao.upsertSettingOverride failed");
  }
}

/**
 * Read a single settings override, JSON-parsed.
 *
 * `undefined` means the override is missing (no row) or persistence is
 * disabled; `null` means a value was stored explicitly as JSON null.
 * To remove an override entirely, use `deleteSettingOverride`.
 */
export function getSettingOverride<T = unknown>(scope: string, key: string): T | null | undefined {
  const db = openDatabase();
  if (!db) return undefined;
  try {
    const row = db
      .prepare(`SELECT value_json FROM settings_overrides WHERE scope = ? AND key = ?`)
      .get(scope, key) as { value_json?: string } | undefined;
    if (!row || row.value_json == null) return undefined;
    return JSON.parse(row.value_json) as T | null;
  } catch (err) {
    logger.debug({ err }, "dao.getSettingOverride failed");
    return undefined;
  }
}

/** Delete a settings override (revert to the file-based default). */
export function deleteSettingOverride(scope: string, key: string): void {
  const db = openDatabase();
  if (!db) return;
  try {
    db.prepare(`DELETE FROM settings_overrides WHERE scope = ? AND key = ?`).run(scope, key);
  } catch (err) {
    logger.debug({ err }, "dao.deleteSettingOverride failed");
  }
}

/** Record an AI cost/usage event. Returns the rowid, or null when disabled. */
export function recordCostEvent(opts: {
  owner?: string | null;
  repo?: string | null;
  number?: number | null;
  reviewId?: number | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  /** e.g. "review", "summary", "chat", "plan". */
  kind?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  try {
    const info = db.prepare(
      `INSERT INTO cost_events (ts, owner, repo, number, review_id, provider, model, input_tokens, output_tokens, cost_usd, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      opts.owner ?? null,
      opts.repo ?? null,
      opts.number ?? null,
      opts.reviewId ?? null,
      opts.provider ?? null,
      opts.model ?? null,
      opts.inputTokens ?? null,
      opts.outputTokens ?? null,
      opts.costUsd ?? null,
      opts.kind ?? null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.recordCostEvent failed");
    return null;
  }
}

/**
 * Record a raw webhook delivery (for the deliveries view + replay). Returns the
 * rowid, or null when disabled.
 */
export function recordWebhookDelivery(opts: {
  event: string;
  action?: string | null;
  owner?: string | null;
  repo?: string | null;
  number?: number | null;
  deliveryId?: string | null;
  signatureOk?: boolean | null;
  payload?: unknown;
  /** rowid of the delivery this is a replay of, if any. */
  replayedFrom?: number | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  try {
    const payloadJson = safeJsonStringify(opts.payload);
    const info = db.prepare(
      `INSERT INTO webhook_deliveries (ts, event, action, owner, repo, number, delivery_id, signature_ok, payload_json, replayed_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      opts.event,
      opts.action ?? null,
      opts.owner ?? null,
      opts.repo ?? null,
      opts.number ?? null,
      opts.deliveryId ?? null,
      opts.signatureOk == null ? null : opts.signatureOk ? 1 : 0,
      payloadJson == null ? null : payloadJson.slice(0, 1_000_000),
      opts.replayedFrom ?? null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.recordWebhookDelivery failed");
    return null;
  }
}

/**
 * Apply triage state to a finding (snooze, accept/dismiss note, triager).
 * Only the provided fields are written; omitted fields are left untouched.
 *
 * Returns true when a row was actually updated; false when persistence is
 * disabled, no triage field was supplied, the finding id matched nothing, or
 * an error was caught.
 */
export function triageFinding(opts: {
  findingId: number;
  accepted?: boolean | null;
  snoozedUntil?: string | null;
  triagedBy?: string | null;
  triageNote?: string | null;
}): boolean {
  const db = openDatabase();
  if (!db) return false;
  try {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (opts.accepted !== undefined) {
      sets.push("accepted = ?");
      params.push(opts.accepted == null ? null : opts.accepted ? 1 : 0);
    }
    if (opts.snoozedUntil !== undefined) {
      sets.push("snoozed_until = ?");
      params.push(opts.snoozedUntil);
    }
    if (opts.triageNote !== undefined) {
      sets.push("triage_note = ?");
      params.push(opts.triageNote);
    }
    if (opts.triagedBy !== undefined) {
      sets.push("triaged_by = ?");
      params.push(opts.triagedBy);
    }
    // No actual triage field supplied — don't stamp triaged_at (or touch the
    // row at all) for a no-op call (e.g. only `findingId` was passed).
    if (sets.length === 0) return false;
    // Stamp when any field is updated.
    sets.push("triaged_at = ?");
    params.push(new Date().toISOString());
    params.push(opts.findingId);
    const info = db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.triageFinding failed");
    return false;
  }
}

/** Canonical command-center roles the dashboard gates write access on. */
export const VALID_ROLES = ["viewer", "author", "admin"] as const;
const VALID_ROLE_SET = new Set<string>(VALID_ROLES);

/** Set (or clear) a role override for a login. role=null removes the override. */
export function setRole(opts: { login: string; role: string | null; grantedBy?: string | null }): void {
  const db = openDatabase();
  if (!db) return;
  try {
    if (opts.role == null) {
      db.prepare(`DELETE FROM roles WHERE login = ?`).run(opts.login);
      return;
    }
    if (!VALID_ROLE_SET.has(opts.role)) {
      logger.debug({ login: opts.login, role: opts.role }, "dao.setRole: unknown role — refusing to persist");
      return;
    }
    db.prepare(
      `INSERT INTO roles (login, role, granted_by, granted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET
         role = excluded.role,
         granted_by = excluded.granted_by,
         granted_at = excluded.granted_at`,
    ).run(opts.login, opts.role, opts.grantedBy ?? null, new Date().toISOString());
  } catch (err) {
    logger.debug({ err }, "dao.setRole failed");
  }
}

/** Read a role override for a login, or undefined when unset/disabled. */
export function getRole(login: string): string | undefined {
  const db = openDatabase();
  if (!db) return undefined;
  try {
    const row = db.prepare(`SELECT role FROM roles WHERE login = ?`).get(login) as { role?: string } | undefined;
    return row?.role ?? undefined;
  } catch (err) {
    logger.debug({ err }, "dao.getRole failed");
    return undefined;
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
