import type { Database as DB } from "better-sqlite3";
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

/** DBs whose v2 schema probe has succeeded — keyed by the handle itself so a
 *  reopened/different DB is re-probed rather than inheriting a stale result. */
const v2SchemaOkDbs = new WeakSet<DB>();
/** One-shot throttle for the missing-schema warning (logging only — never the
 *  schema result), so a missing v2 schema doesn't log on every v2 access. */
let _v2SchemaMissingWarned = false;

/** Every table introduced by the command-center (v2) migration — a full
 *  "did migration 2 run" check, not just the subset the DAO helpers touch. */
const REQUIRED_V2_TABLES = [
  "audit_log",
  "settings_overrides",
  "api_tokens",
  "cost_events",
  "notification_channels",
  "alert_rules",
  "saved_views",
  "webhook_deliveries",
  "roles",
];
/** Triage columns the v2 helpers depend on (`accepted` is v1; the rest are v2). */
const REQUIRED_FINDINGS_COLUMNS = ["accepted", "snoozed_until", "triaged_by", "triaged_at", "triage_note"];

/**
 * Guard for command-center (schema v2) helpers. `openDatabase()` runs the
 * migration runner on first open, so a successfully-opened DB is normally at
 * the latest version — this is a defensive check so that an un-migrated DB
 * surfaces a distinct, loud warning instead of every v2 access silently
 * no-opping as if persistence were merely disabled (a `null` db). Returns true
 * when the v2 tables/columns are present.
 *
 * Only a successful probe is cached, per-DB via a WeakSet: the schema only
 * moves forward within a run, so once present it stays present and we skip the
 * PRAGMA lookups. A failed/missing probe is NOT cached, so a DB that migrates
 * after the first call (or a transient error) can recover on a later call.
 */
function ensureCommandCenterSchema(db: DB): boolean {
  if (v2SchemaOkDbs.has(db)) return true;
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const findingsCols = new Set(
      (db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const ok =
      REQUIRED_V2_TABLES.every((t) => tables.has(t)) &&
      REQUIRED_FINDINGS_COLUMNS.every((c) => findingsCols.has(c));
    if (ok) {
      v2SchemaOkDbs.add(db);
      return true;
    }
    if (!_v2SchemaMissingWarned) {
      _v2SchemaMissingWarned = true;
      logger.warn(
        "Command-center (v2) schema is missing — migrations may not have run. v2 DAO access will be skipped.",
      );
    }
    return false;
  } catch (err) {
    if (!_v2SchemaMissingWarned) {
      _v2SchemaMissingWarned = true;
      logger.warn({ err }, "Command-center (v2) schema check failed");
    }
    return false;
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
  if (!ensureCommandCenterSchema(db)) return null;
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
 * A settings-override scope is either the literal 'global' or an 'owner/repo'
 * pair — exactly two non-empty segments. We enforce only the shape (not a
 * character allow-list) so legitimate repository names are never dropped;
 * anything else is rejected so a typo can't silently write a row no read will
 * ever match.
 */
function isValidScope(scope: string): boolean {
  if (scope === "global") return true;
  const parts = scope.split("/");
  return parts.length === 2 && parts.every((p) => p.length > 0);
}

/** A settings-override key must be a non-empty, non-whitespace string. */
function isValidKey(key: string): boolean {
  return typeof key === "string" && key.trim().length > 0;
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
  if (!ensureCommandCenterSchema(db)) return;
  if (!isValidScope(opts.scope)) {
    logger.debug({ scope: opts.scope, key: opts.key }, "dao.upsertSettingOverride: invalid scope — skipping write");
    return;
  }
  if (!isValidKey(opts.key)) {
    logger.debug({ scope: opts.scope, key: opts.key }, "dao.upsertSettingOverride: invalid key — skipping write");
    return;
  }
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
  if (!ensureCommandCenterSchema(db)) return undefined;
  if (!isValidScope(scope)) {
    logger.debug({ scope, key }, "dao.getSettingOverride: invalid scope — ignoring");
    return undefined;
  }
  if (!isValidKey(key)) {
    logger.debug({ scope, key }, "dao.getSettingOverride: invalid key — ignoring");
    return undefined;
  }
  try {
    const row = db
      .prepare(`SELECT value_json FROM settings_overrides WHERE scope = ? AND key = ?`)
      .get(scope, key) as { value_json?: string } | undefined;
    if (!row || row.value_json == null) return undefined;
    try {
      return JSON.parse(row.value_json) as T | null;
    } catch (parseErr) {
      // A corrupted persisted override must be distinguishable in logs from a
      // normal miss (which logs nothing and also returns undefined).
      logger.warn({ err: parseErr, scope, key }, "dao.getSettingOverride: invalid stored JSON — ignoring override");
      return undefined;
    }
  } catch (err) {
    logger.debug({ err }, "dao.getSettingOverride failed");
    return undefined;
  }
}

/** Delete a settings override (revert to the file-based default). */
export function deleteSettingOverride(scope: string, key: string): void {
  const db = openDatabase();
  if (!db) return;
  if (!ensureCommandCenterSchema(db)) return;
  if (!isValidScope(scope)) {
    logger.debug({ scope, key }, "dao.deleteSettingOverride: invalid scope — skipping");
    return;
  }
  if (!isValidKey(key)) {
    logger.debug({ scope, key }, "dao.deleteSettingOverride: invalid key — skipping");
    return;
  }
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
  if (!ensureCommandCenterSchema(db)) return null;
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
  if (!ensureCommandCenterSchema(db)) return null;
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
  if (!ensureCommandCenterSchema(db)) return false;
  try {
    // Each supplied triage field contributes a COMPLETE literal SQL fragment
    // (no column name is ever interpolated from a variable) plus the value to
    // bind. The `diff` predicate uses null-safe `IS NOT` so the UPDATE only
    // matches when at least one supplied field actually differs — repeat calls
    // with identical values then leave the row (and triaged_at) untouched.
    const updates: Array<{ set: string; diff: string; value: unknown }> = [];
    if (opts.accepted !== undefined) {
      updates.push({
        set: "accepted = ?",
        diff: "accepted IS NOT ?",
        value: opts.accepted == null ? null : opts.accepted ? 1 : 0,
      });
    }
    if (opts.snoozedUntil !== undefined) {
      updates.push({ set: "snoozed_until = ?", diff: "snoozed_until IS NOT ?", value: opts.snoozedUntil });
    }
    if (opts.triageNote !== undefined) {
      updates.push({ set: "triage_note = ?", diff: "triage_note IS NOT ?", value: opts.triageNote });
    }
    if (opts.triagedBy !== undefined) {
      updates.push({ set: "triaged_by = ?", diff: "triaged_by IS NOT ?", value: opts.triagedBy });
    }
    // No actual triage field supplied — don't stamp triaged_at (or touch the
    // row at all) for a no-op call (e.g. only `findingId` was passed).
    if (updates.length === 0) return false;

    const setClauses = updates.map((u) => u.set);
    const setValues = updates.map((u) => u.value);
    const diffPredicates = updates.map((u) => u.diff);
    const diffValues = updates.map((u) => u.value);
    // Stamp the time only on a row we actually update.
    setClauses.push("triaged_at = ?");
    setValues.push(new Date().toISOString());

    // Placeholder order is explicit: every SET value, then `id`, then every
    // diff-predicate value. The .run() args below mirror that order exactly.
    const sql = `UPDATE findings SET ${setClauses.join(", ")} WHERE id = ? AND (${diffPredicates.join(" OR ")})`;
    const info = db.prepare(sql).run(...setValues, opts.findingId, ...diffValues);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.triageFinding failed");
    return false;
  }
}

/** Canonical command-center roles the dashboard gates write access on. */
export const VALID_ROLES = ["viewer", "author", "admin"] as const;
export type Role = (typeof VALID_ROLES)[number];
const VALID_ROLE_SET = new Set<string>(VALID_ROLES);

/**
 * Set (or clear) a role override for a login. role=null removes the override.
 * `role` is typed `string` (not `Role`) on purpose: this is a runtime-safe
 * boundary for untyped API input, and `VALID_ROLE_SET` is the real gate.
 */
export function setRole(opts: { login: string; role: string | null; grantedBy?: string | null }): void {
  const db = openDatabase();
  if (!db) return;
  if (!ensureCommandCenterSchema(db)) return;
  // GitHub logins are case-insensitive — canonicalize to lowercase so a value
  // set as "Alice" is read back by getRole("alice").
  const login = (opts.login ?? "").trim().toLowerCase();
  if (login.length === 0) {
    logger.debug({ login: opts.login }, "dao.setRole: empty login — skipping");
    return;
  }
  try {
    if (opts.role == null) {
      db.prepare(`DELETE FROM roles WHERE login = ?`).run(login);
      return;
    }
    if (!VALID_ROLE_SET.has(opts.role)) {
      logger.debug({ login, role: opts.role }, "dao.setRole: unknown role — refusing to persist");
      return;
    }
    db.prepare(
      `INSERT INTO roles (login, role, granted_by, granted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET
         role = excluded.role,
         granted_by = excluded.granted_by,
         granted_at = excluded.granted_at`,
    ).run(login, opts.role, opts.grantedBy ?? null, new Date().toISOString());
  } catch (err) {
    logger.debug({ err }, "dao.setRole failed");
  }
}

/**
 * Read a role override for a login. Returns undefined when unset, disabled, or
 * when the stored role is not a recognized value — so downstream authorization
 * falls back to the safe default rather than trusting an unknown role string.
 */
export function getRole(login: string): Role | undefined {
  const db = openDatabase();
  if (!db) return undefined;
  if (!ensureCommandCenterSchema(db)) return undefined;
  // Match setRole's canonicalization (trim + lowercase) so reads hit the same key.
  const normalizedLogin = (login ?? "").trim().toLowerCase();
  if (normalizedLogin.length === 0) return undefined;
  try {
    const row = db.prepare(`SELECT role FROM roles WHERE login = ?`).get(normalizedLogin) as
      | { role?: string }
      | undefined;
    const role = row?.role;
    if (role == null) return undefined;
    if (!VALID_ROLE_SET.has(role)) {
      logger.warn({ login: normalizedLogin, role }, "dao.getRole: stored role is not recognized — ignoring");
      return undefined;
    }
    // Safe: VALID_ROLE_SET.has(role) just confirmed role is one of VALID_ROLES.
    return role as Role;
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
