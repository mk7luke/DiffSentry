import type { Database as DB } from "better-sqlite3";
import { openDatabase } from "./db.js";
import type { AntiPattern, CommentSeverity, CommentType, IssueContext, PRContext, ReviewComment, ReviewResult } from "../types.js";
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

/** Per-DB record of which dependency sets have probed OK — keyed by the handle
 *  itself so a reopened/different DB is re-probed rather than inheriting a
 *  stale result. The inner Set holds dependency-set keys (see depsKey below). */
const v2SchemaOkByDb = new WeakMap<DB, Set<string>>();
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
 * Each caller declares only the tables/finding-columns it actually touches, so
 * a missing *unrelated* v2 table doesn't block a helper that doesn't use it
 * (defaults to the full v2 set). Successful probes are cached per (db,
 * dependency-set); a failed/missing probe is NOT cached, so a DB that migrates
 * after the first call (or a transient error) can recover on a later call.
 */
function ensureCommandCenterSchema(
  db: DB,
  requiredTables: readonly string[] = REQUIRED_V2_TABLES,
  // Defaults to [] so table-only callers (insertAuditLog, upsertSettingOverride,
  // setRole, ...) don't implicitly depend on the `findings` triage columns.
  // triageFinding passes REQUIRED_FINDINGS_COLUMNS explicitly.
  requiredFindingColumns: readonly string[] = [],
): boolean {
  const depsKey = `${[...requiredTables].sort().join(",")}|${[...requiredFindingColumns].sort().join(",")}`;
  let okSet = v2SchemaOkByDb.get(db);
  if (okSet?.has(depsKey)) return true;
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const findingsCols = new Set(
      (db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const missingTables = requiredTables.filter((t) => !tables.has(t));
    const missingColumns = requiredFindingColumns.filter((c) => !findingsCols.has(c));
    if (missingTables.length === 0 && missingColumns.length === 0) {
      if (!okSet) {
        okSet = new Set();
        v2SchemaOkByDb.set(db, okSet);
      }
      okSet.add(depsKey);
      return true;
    }
    if (!_v2SchemaMissingWarned) {
      _v2SchemaMissingWarned = true;
      logger.warn(
        { missingTables, missingColumns },
        "Command-center (v2) schema is incomplete — migrations may not have run. Affected DAO access will be skipped.",
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
  if (!ensureCommandCenterSchema(db, ["audit_log"])) return null;
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
  if (!ensureCommandCenterSchema(db, ["settings_overrides"])) return;
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
  if (!ensureCommandCenterSchema(db, ["settings_overrides"])) return undefined;
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
  if (!ensureCommandCenterSchema(db, ["settings_overrides"])) return;
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

/** A single settings-override mutation: set a value, or clear the key. */
export type SettingOverrideOp = { key: string; value: unknown } | { key: string; clear: true };

/**
 * Apply several settings-override mutations to one scope atomically: all ops run
 * in a single SQLite transaction, so a mid-batch failure rolls the whole batch
 * back rather than leaving a half-applied multi-field change (e.g. a branding
 * update that sets the name but not the accent).
 *
 * Returns true when the batch is applied — or when persistence is disabled
 * (nothing to do is not a failure). Returns false only when the scope/key is
 * invalid, a value can't be serialized, or the transaction itself errors; in
 * every false case nothing is written. Input is validated and values are
 * pre-serialized before the transaction opens, so the tx body runs only trusted
 * statements.
 */
export function applySettingOverrides(
  scope: string,
  ops: SettingOverrideOp[],
  updatedBy: string | null,
): boolean {
  const db = openDatabase();
  if (!db) return true; // persistence disabled — a no-op, not an error
  if (!ensureCommandCenterSchema(db, ["settings_overrides"])) return false;
  if (!isValidScope(scope)) {
    logger.debug({ scope }, "dao.applySettingOverrides: invalid scope — skipping batch");
    return false;
  }
  if (ops.length === 0) return true;

  type Prepared = { kind: "upsert"; key: string; valueJson: string } | { kind: "delete"; key: string };
  const prepared: Prepared[] = [];
  for (const op of ops) {
    if (!isValidKey(op.key)) {
      logger.debug({ scope, key: op.key }, "dao.applySettingOverrides: invalid key — skipping batch");
      return false;
    }
    if ("clear" in op) {
      prepared.push({ kind: "delete", key: op.key });
    } else {
      const valueJson = safeJsonStringify(op.value);
      if (valueJson == null) {
        logger.debug({ scope, key: op.key }, "dao.applySettingOverrides: value not JSON-serializable — skipping batch");
        return false;
      }
      prepared.push({ kind: "upsert", key: op.key, valueJson });
    }
  }

  try {
    const upsert = db.prepare(
      `INSERT INTO settings_overrides (scope, key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    );
    const del = db.prepare(`DELETE FROM settings_overrides WHERE scope = ? AND key = ?`);
    const now = new Date().toISOString();
    const tx = db.transaction((items: Prepared[]) => {
      for (const item of items) {
        if (item.kind === "upsert") upsert.run(scope, item.key, item.valueJson, updatedBy ?? null, now);
        else del.run(scope, item.key);
      }
    });
    tx(prepared);
    return true;
  } catch (err) {
    logger.debug({ err, scope }, "dao.applySettingOverrides failed");
    return false;
  }
}

/** One override mutation in a settings batch: set `value` for `key`, or clear it. */
export interface SettingChange {
  key: string;
  /** When true the override is deleted (revert to default); `value` is ignored. */
  clear: boolean;
  value: unknown;
}

/**
 * Apply a batch of settings overrides for one scope atomically, writing an
 * `audit_log` row for each in the SAME transaction — either every override +
 * audit row persists, or none do. Unlike the per-call helpers above (which each
 * open the db and swallow errors), this owns one transaction so a mid-batch
 * failure rolls the whole thing back.
 *
 * Return values let the caller decide whether to emit bus events:
 *   - true  → committed, OR persistence is gracefully off (no db / schema absent),
 *             matching the documented no-op behavior — the caller may still notify.
 *   - false → a real failure (invalid scope/key, unrepresentable value, or the
 *             transaction threw): nothing persisted, so the caller must NOT
 *             audit/publish success.
 *
 * The audit payload (`{ value }`) and actions (`settings.set` / `settings.clear`)
 * mirror what insertAuditLog wrote per-call before, so existing audit readers
 * are unaffected.
 */
export function commitSettingsChanges(opts: {
  scope: string;
  updatedBy?: string | null;
  actorLogin?: string | null;
  actorRole?: string | null;
  changes: SettingChange[];
}): boolean {
  const db = openDatabase();
  if (!db) return true; // persistence off — graceful no-op
  if (!ensureCommandCenterSchema(db, ["settings_overrides", "audit_log"])) return true;
  if (!isValidScope(opts.scope)) {
    logger.debug({ scope: opts.scope }, "dao.commitSettingsChanges: invalid scope — skipping write");
    return false;
  }
  if (opts.changes.length === 0) return true;

  // Validate keys + serialize values BEFORE opening the transaction, so a bad
  // entry aborts the whole batch without partially writing anything.
  const prepared: Array<{ key: string; clear: boolean; valueJson: string | null; auditJson: string | null }> = [];
  for (const c of opts.changes) {
    if (!isValidKey(c.key)) {
      logger.debug({ scope: opts.scope, key: c.key }, "dao.commitSettingsChanges: invalid key — aborting batch");
      return false;
    }
    let valueJson: string | null = null;
    if (!c.clear) {
      valueJson = safeJsonStringify(c.value);
      if (valueJson == null) {
        logger.debug(
          { scope: opts.scope, key: c.key },
          "dao.commitSettingsChanges: value not JSON-serializable — aborting batch",
        );
        return false;
      }
    }
    // Audit payload mirrors the prior per-call shape: { value } (null on clear).
    const auditJson = safeJsonStringify({ value: c.clear ? null : c.value });
    prepared.push({ key: c.key, clear: c.clear, valueJson, auditJson });
  }

  try {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      `INSERT INTO settings_overrides (scope, key, value_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    );
    const del = db.prepare(`DELETE FROM settings_overrides WHERE scope = ? AND key = ?`);
    const audit = db.prepare(
      `INSERT INTO audit_log (ts, actor_login, actor_role, action, target_type, target_ref, payload_json, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: typeof prepared) => {
      for (const p of rows) {
        if (p.clear) {
          del.run(opts.scope, p.key);
        } else {
          upsert.run(opts.scope, p.key, p.valueJson, opts.updatedBy ?? null, now);
        }
        audit.run(
          now,
          opts.actorLogin ?? null,
          opts.actorRole ?? null,
          p.clear ? "settings.clear" : "settings.set",
          "setting",
          `${opts.scope}:${p.key}`,
          p.auditJson == null ? null : p.auditJson.slice(0, 100_000),
          "ok",
        );
      }
    });
    tx(prepared);
    return true;
  } catch (err) {
    logger.debug({ err, scope: opts.scope }, "dao.commitSettingsChanges failed — rolled back");
    return false;
  }
}

// ─── Custom anti-pattern rules (admin-authored, migration v3) ──────────────

/** Canonical severities/types a custom rule may use — mirror types.ts. */
export const CUSTOM_RULE_SEVERITIES = ["critical", "major", "minor", "trivial"] as const;
export const CUSTOM_RULE_TYPES = ["issue", "suggestion", "nitpick", "documentation", "security"] as const;
/** Rule kinds the engine can compile. AST is reserved for a future migration. */
export const CUSTOM_RULE_KINDS = ["regex"] as const;

/** A row from the custom_rules table, as stored. */
export interface CustomRuleRow {
  id: number;
  scope: string;
  kind: string;
  name: string;
  severity: string;
  type: string;
  pattern: string;
  flags: string | null;
  path_glob: string | null;
  message: string | null;
  advice: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Writable fields for create/update. `enabled` defaults to true on create. */
export interface CustomRuleInput {
  scope?: string;
  kind?: string;
  name: string;
  severity?: string;
  type?: string;
  pattern: string;
  flags?: string | null;
  pathGlob?: string | null;
  message?: string | null;
  advice?: string | null;
  enabled?: boolean;
}

/** List every custom rule (newest first). Empty when persistence is off. */
export function listCustomRules(opts: { scope?: string } = {}): CustomRuleRow[] {
  const db = openDatabase();
  if (!db) return [];
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return [];
  try {
    if (opts.scope) {
      return db
        .prepare(`SELECT * FROM custom_rules WHERE scope = ? ORDER BY id DESC`)
        .all(opts.scope) as CustomRuleRow[];
    }
    return db.prepare(`SELECT * FROM custom_rules ORDER BY id DESC`).all() as CustomRuleRow[];
  } catch (err) {
    logger.debug({ err }, "dao.listCustomRules failed");
    return [];
  }
}

/** Fetch a single custom rule by id, or null when missing / disabled. */
export function getCustomRule(id: number): CustomRuleRow | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return null;
  try {
    const row = db.prepare(`SELECT * FROM custom_rules WHERE id = ?`).get(id) as CustomRuleRow | undefined;
    return row ?? null;
  } catch (err) {
    logger.debug({ err, id }, "dao.getCustomRule failed");
    return null;
  }
}

/**
 * True when a custom rule with this exact name already exists (optionally
 * excluding one id, for renames). Custom-rule names must be globally unique
 * because pattern_hits is joined back to rules by name — two same-named rules
 * would merge their hit-counts. Returns false when persistence is off; the
 * UNIQUE index on custom_rules(name) is the hard backstop.
 */
export function customRuleNameExists(name: string, excludeId?: number): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return false;
  try {
    const row =
      excludeId != null
        ? db.prepare(`SELECT 1 FROM custom_rules WHERE name = ? AND id <> ? LIMIT 1`).get(name, excludeId)
        : db.prepare(`SELECT 1 FROM custom_rules WHERE name = ? LIMIT 1`).get(name);
    return row != null;
  } catch (err) {
    logger.debug({ err }, "dao.customRuleNameExists failed");
    return false;
  }
}

/** Insert a new custom rule. Returns the new id, or null when disabled. */
export function insertCustomRule(input: CustomRuleInput, createdBy?: string | null): number | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return null;
  try {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO custom_rules
           (scope, kind, name, severity, type, pattern, flags, path_glob, message, advice, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope ?? "global",
        input.kind ?? "regex",
        input.name,
        input.severity ?? "minor",
        input.type ?? "suggestion",
        input.pattern,
        input.flags ?? null,
        input.pathGlob ?? null,
        input.message ?? null,
        input.advice ?? null,
        input.enabled === false ? 0 : 1,
        createdBy ?? null,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.insertCustomRule failed");
    return null;
  }
}

/**
 * Update an existing custom rule in place. Only the provided fields change.
 * Returns true when a row was updated, false otherwise (missing / disabled DB).
 */
export function updateCustomRule(id: number, input: Partial<CustomRuleInput>): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return false;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if (input.scope !== undefined) push("scope", input.scope);
  if (input.kind !== undefined) push("kind", input.kind);
  if (input.name !== undefined) push("name", input.name);
  if (input.severity !== undefined) push("severity", input.severity);
  if (input.type !== undefined) push("type", input.type);
  if (input.pattern !== undefined) push("pattern", input.pattern);
  if (input.flags !== undefined) push("flags", input.flags ?? null);
  if (input.pathGlob !== undefined) push("path_glob", input.pathGlob ?? null);
  if (input.message !== undefined) push("message", input.message ?? null);
  if (input.advice !== undefined) push("advice", input.advice ?? null);
  if (input.enabled !== undefined) push("enabled", input.enabled ? 1 : 0);
  if (sets.length === 0) return false;
  push("updated_at", new Date().toISOString());
  try {
    const info = db.prepare(`UPDATE custom_rules SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err, id }, "dao.updateCustomRule failed");
    return false;
  }
}

/** Delete a custom rule. Returns true when a row was removed. */
export function deleteCustomRule(id: number): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return false;
  try {
    const info = db.prepare(`DELETE FROM custom_rules WHERE id = ?`).run(id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err, id }, "dao.deleteCustomRule failed");
    return false;
  }
}

/** An AntiPattern plus its DB id, so recorded hits can be tied back to the exact
 * admin rule (the stable analytics key) rather than matched by name. */
export type CustomRuleForEngine = AntiPattern & { id: number };

/**
 * Load the enabled custom rules that apply to a repo — global rules plus any
 * scoped to exactly `owner/repo` — shaped as AntiPattern (+ id) for the pattern
 * engine. Empty when persistence is off, so the engine simply runs without them.
 */
export function listCustomRulesForRepo(owner: string, repo: string): CustomRuleForEngine[] {
  const db = openDatabase();
  if (!db) return [];
  if (!ensureCommandCenterSchema(db, ["custom_rules"])) return [];
  try {
    const rows = db
      .prepare(
        `SELECT * FROM custom_rules
         WHERE enabled = 1 AND kind = 'regex' AND (scope = 'global' OR scope = ?)
         ORDER BY id ASC`,
      )
      .all(`${owner}/${repo}`) as CustomRuleRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      pattern: r.pattern,
      flags: r.flags ?? undefined,
      severity: (r.severity as CommentSeverity) ?? "minor",
      type: (r.type as CommentType) ?? "suggestion",
      message: r.message ?? undefined,
      advice: r.advice ?? undefined,
      path: r.path_glob ?? undefined,
    }));
  } catch (err) {
    logger.debug({ err, owner, repo }, "dao.listCustomRulesForRepo failed");
    return [];
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
  if (!ensureCommandCenterSchema(db, ["cost_events"])) return null;
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
  if (!ensureCommandCenterSchema(db, ["webhook_deliveries"])) return null;
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
  if (!ensureCommandCenterSchema(db, [], REQUIRED_FINDINGS_COLUMNS)) return false;
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

/** A finding's PR coordinates — used to attribute triage events on the bus. */
export interface FindingCoords {
  id: number;
  owner: string;
  repo: string;
  number: number;
  fingerprint: string | null;
}

/**
 * Resolve the PR coordinates (owner/repo/number) for a set of finding ids.
 * Used by the API to publish an `action.performed` bus event per affected PR
 * after a triage write. Returns [] when persistence is disabled or no id
 * matched. Ids are bound positionally — never interpolated into the SQL text.
 */
export function getFindingCoords(ids: number[]): FindingCoords[] {
  const db = openDatabase();
  if (!db || ids.length === 0) return [];
  try {
    const placeholders = ids.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT fi.id, rv.owner, rv.repo, rv.number, fi.fingerprint
         FROM findings fi
         JOIN reviews rv ON rv.id = fi.review_id
         WHERE fi.id IN (${placeholders})`,
      )
      .all(...ids) as FindingCoords[];
  } catch (err) {
    logger.debug({ err }, "dao.getFindingCoords failed");
    return [];
  }
}

/**
 * Every finding id sharing a fingerprint — the "dismiss a whole class" path.
 * Capped so a pathological fingerprint can't trigger an unbounded UPDATE.
 */
export function getFindingIdsByFingerprint(fingerprint: string, limit = 1000): number[] {
  const db = openDatabase();
  if (!db || !fingerprint) return [];
  try {
    const cap = Math.min(Math.max(limit, 1), 5000);
    const rows = db
      .prepare(`SELECT id FROM findings WHERE fingerprint = ? ORDER BY id DESC LIMIT ?`)
      .all(fingerprint, cap) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  } catch (err) {
    logger.debug({ err }, "dao.getFindingIdsByFingerprint failed");
    return [];
  }
}

/**
 * Apply the same triage state to many findings in one statement. Mirrors
 * triageFinding's safe-fragment construction (no column name is interpolated)
 * but binds an `IN (...)` list of ids. Returns the number of rows actually
 * changed (rows already at the target state are left untouched by the null-safe
 * `IS NOT` diff predicate, so re-applying is a no-op).
 */
export function bulkTriageFindings(opts: {
  ids: number[];
  accepted?: boolean | null;
  snoozedUntil?: string | null;
  triagedBy?: string | null;
  triageNote?: string | null;
}): number {
  const db = openDatabase();
  if (!db || opts.ids.length === 0) return 0;
  if (!ensureCommandCenterSchema(db, [], REQUIRED_FINDINGS_COLUMNS)) return 0;
  try {
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
    if (updates.length === 0) return 0;

    const setClauses = updates.map((u) => u.set);
    const setValues = updates.map((u) => u.value);
    const diffPredicates = updates.map((u) => u.diff);
    const diffValues = updates.map((u) => u.value);
    setClauses.push("triaged_at = ?");
    setValues.push(new Date().toISOString());

    const placeholders = opts.ids.map(() => "?").join(", ");
    // Placeholder order: every SET value, then the id list, then every
    // diff-predicate value. The .run() args mirror that order exactly.
    const sql = `UPDATE findings SET ${setClauses.join(", ")} WHERE id IN (${placeholders}) AND (${diffPredicates.join(" OR ")})`;
    const info = db.prepare(sql).run(...setValues, ...opts.ids, ...diffValues);
    return info.changes;
  } catch (err) {
    logger.debug({ err }, "dao.bulkTriageFindings failed");
    return 0;
  }
}

/**
 * The set of fingerprints a review may suppress: findings explicitly dismissed
 * (accepted = 0) or currently snoozed (snoozed_until in the future). This is the
 * read the engine consults when DIFFSENTRY_SUPPRESS_DISMISSED is enabled — it
 * is opt-in precisely because it changes review output. Returns an empty set
 * (never throws) when persistence or the v2 schema is unavailable, so the
 * engine degrades to its default behavior.
 */
export function getSuppressedFingerprints(nowIso = new Date().toISOString()): Set<string> {
  const db = openDatabase();
  if (!db) return new Set();
  if (!ensureCommandCenterSchema(db, [], REQUIRED_FINDINGS_COLUMNS)) return new Set();
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT fingerprint FROM findings
         WHERE fingerprint IS NOT NULL AND fingerprint <> ''
           AND (accepted = 0 OR (snoozed_until IS NOT NULL AND snoozed_until > ?))`,
      )
      .all(nowIso) as Array<{ fingerprint: string }>;
    return new Set(rows.map((r) => r.fingerprint));
  } catch (err) {
    logger.debug({ err }, "dao.getSuppressedFingerprints failed");
    return new Set();
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
export function setRole(opts: { login?: string | null; role: string | null; grantedBy?: string | null }): void {
  const db = openDatabase();
  if (!db) return;
  if (!ensureCommandCenterSchema(db, ["roles"])) return;
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
export function getRole(login: string | null | undefined): Role | undefined {
  const db = openDatabase();
  if (!db) return undefined;
  if (!ensureCommandCenterSchema(db, ["roles"])) return undefined;
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

// ---------------------------------------------------------------------------
// API tokens — bearer credentials for the platform API. The plaintext token is
// shown to its creator exactly once; only a SHA-256 hash is persisted. Auth
// looks a token up by hash (the hash column is indexed), checks it is not
// revoked, and bumps last_used_at. All best-effort no-ops when the DB is off.
// Token minting/hashing lives in src/api/token-auth.ts; this layer only stores
// and retrieves rows.
// ---------------------------------------------------------------------------

export interface ApiTokenRow {
  id: number;
  name: string | null;
  created_by: string | null;
  created_at: string | null;
  last_used_at: string | null;
  scopes_json: string | null;
  revoked_at: string | null;
}

/** Insert an API token (its hash + scopes). Returns the new id, or null when
 *  persistence is disabled. The caller passes the already-computed hash so the
 *  plaintext never reaches storage. */
export function createApiToken(opts: {
  name?: string | null;
  tokenHash: string;
  scopes: string[];
  createdBy?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["api_tokens"])) return null;
  try {
    const info = db.prepare(
      `INSERT INTO api_tokens (name, token_hash, created_by, created_at, scopes_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      opts.name ?? null,
      opts.tokenHash,
      opts.createdBy ?? null,
      new Date().toISOString(),
      JSON.stringify(opts.scopes ?? []),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.createApiToken failed");
    return null;
  }
}

/** List API tokens (metadata only — never the hash). Newest first. */
export function listApiTokens(): ApiTokenRow[] {
  const db = openDatabase();
  if (!db) return [];
  if (!ensureCommandCenterSchema(db, ["api_tokens"])) return [];
  try {
    return db.prepare(
      `SELECT id, name, created_by, created_at, last_used_at, scopes_json, revoked_at
       FROM api_tokens ORDER BY id DESC`,
    ).all() as ApiTokenRow[];
  } catch (err) {
    logger.debug({ err }, "dao.listApiTokens failed");
    return [];
  }
}

/**
 * Revoke a token by id. Idempotent: only stamps revoked_at when it is still
 * NULL, so re-revoking is a harmless no-op. Returns true when a row actually
 * transitioned from active to revoked.
 */
export function revokeApiToken(id: number): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["api_tokens"])) return false;
  try {
    const info = db.prepare(
      `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).run(new Date().toISOString(), id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.revokeApiToken failed");
    return false;
  }
}

/**
 * Look up an ACTIVE (non-revoked) token by its hash — the auth hot path.
 * Returns undefined when the token is unknown, revoked, or persistence is off.
 */
export function findActiveApiTokenByHash(tokenHash: string): ApiTokenRow | undefined {
  const db = openDatabase();
  if (!db) return undefined;
  if (!ensureCommandCenterSchema(db, ["api_tokens"])) return undefined;
  try {
    const row = db.prepare(
      `SELECT id, name, created_by, created_at, last_used_at, scopes_json, revoked_at
       FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
    ).get(tokenHash) as ApiTokenRow | undefined;
    return row ?? undefined;
  } catch (err) {
    logger.debug({ err }, "dao.findActiveApiTokenByHash failed");
    return undefined;
  }
}

/** Best-effort bump of a token's last_used_at on a successful authentication. */
export function touchApiTokenLastUsed(id: number): void {
  const db = openDatabase();
  if (!db) return;
  if (!ensureCommandCenterSchema(db, ["api_tokens"])) return;
  try {
    db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  } catch (err) {
    logger.debug({ err }, "dao.touchApiTokenLastUsed failed");
  }
}

// ---------------------------------------------------------------------------
// Notifications — channel + alert-rule config and the delivery log. Channels
// and rules live in the v2 schema (notification_channels / alert_rules);
// deliveries in the v4 notification_deliveries table. All best-effort no-ops
// when persistence is disabled or the table is missing, matching every other
// helper here. Reads live in src/dashboard/queries.ts.
// ---------------------------------------------------------------------------

/** Insert a notification channel. `config` is JSON-serialized (it holds the
 *  webhook URL / SMTP recipient / etc.). Returns the rowid, or null. */
export function insertNotificationChannel(opts: {
  type: string;
  name?: string | null;
  config: unknown;
  enabled?: boolean;
  createdBy?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["notification_channels"])) return null;
  try {
    const configJson = safeJsonStringify(opts.config) ?? "{}";
    const info = db.prepare(
      `INSERT INTO notification_channels (type, name, config_json, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.type,
      opts.name ?? null,
      configJson,
      opts.enabled === false ? 0 : 1,
      opts.createdBy ?? null,
      new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.insertNotificationChannel failed");
    return null;
  }
}

/** Update a channel's name / config / enabled flag. Only provided fields are
 *  written. Returns true when a row changed. */
export function updateNotificationChannel(opts: {
  id: number;
  name?: string | null;
  config?: unknown;
  enabled?: boolean;
}): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["notification_channels"])) return false;
  try {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (opts.name !== undefined) {
      sets.push("name = ?");
      values.push(opts.name);
    }
    if (opts.config !== undefined) {
      sets.push("config_json = ?");
      values.push(safeJsonStringify(opts.config) ?? "{}");
    }
    if (opts.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(opts.enabled ? 1 : 0);
    }
    if (sets.length === 0) return false;
    const info = db.prepare(`UPDATE notification_channels SET ${sets.join(", ")} WHERE id = ?`).run(...values, opts.id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.updateNotificationChannel failed");
    return false;
  }
}

/** Delete a channel. Its rules keep working but their channel_id is set NULL by
 *  the FK (ON DELETE SET NULL), so they simply stop delivering until re-pointed. */
export function deleteNotificationChannel(id: number): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["notification_channels"])) return false;
  try {
    const info = db.prepare(`DELETE FROM notification_channels WHERE id = ?`).run(id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.deleteNotificationChannel failed");
    return false;
  }
}

/** Insert an alert rule. `condition` is JSON-serialized. Returns the rowid. */
export function insertAlertRule(opts: {
  name?: string | null;
  scope?: string | null;
  condition: unknown;
  channelId?: number | null;
  enabled?: boolean;
  createdBy?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["alert_rules"])) return null;
  try {
    const info = db.prepare(
      `INSERT INTO alert_rules (name, scope, condition_json, channel_id, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.name ?? null,
      opts.scope ?? null,
      safeJsonStringify(opts.condition) ?? "{}",
      opts.channelId ?? null,
      opts.enabled === false ? 0 : 1,
      opts.createdBy ?? null,
      new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.insertAlertRule failed");
    return null;
  }
}

/** Update an alert rule. Only provided fields are written. */
export function updateAlertRule(opts: {
  id: number;
  name?: string | null;
  scope?: string | null;
  condition?: unknown;
  channelId?: number | null;
  enabled?: boolean;
}): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["alert_rules"])) return false;
  try {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (opts.name !== undefined) {
      sets.push("name = ?");
      values.push(opts.name);
    }
    if (opts.scope !== undefined) {
      sets.push("scope = ?");
      values.push(opts.scope);
    }
    if (opts.condition !== undefined) {
      sets.push("condition_json = ?");
      values.push(safeJsonStringify(opts.condition) ?? "{}");
    }
    if (opts.channelId !== undefined) {
      sets.push("channel_id = ?");
      values.push(opts.channelId);
    }
    if (opts.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(opts.enabled ? 1 : 0);
    }
    if (sets.length === 0) return false;
    const info = db.prepare(`UPDATE alert_rules SET ${sets.join(", ")} WHERE id = ?`).run(...values, opts.id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.updateAlertRule failed");
    return false;
  }
}

/** Delete an alert rule. */
export function deleteAlertRule(id: number): boolean {
  const db = openDatabase();
  if (!db) return false;
  if (!ensureCommandCenterSchema(db, ["alert_rules"])) return false;
  try {
    const info = db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.deleteAlertRule failed");
    return false;
  }
}

/** Append a notification-delivery row (the alert engine, test-send, and digest
 *  all call this). Returns the rowid, or null. */
export function recordNotificationDelivery(opts: {
  channelId?: number | null;
  channelType?: string | null;
  channelName?: string | null;
  ruleId?: number | null;
  ruleName?: string | null;
  trigger: string;
  target?: string | null;
  title?: string | null;
  status: "ok" | "error";
  detail?: string | null;
}): number | null {
  const db = openDatabase();
  if (!db) return null;
  if (!ensureCommandCenterSchema(db, ["notification_deliveries"])) return null;
  try {
    const info = db.prepare(
      `INSERT INTO notification_deliveries
         (ts, channel_id, channel_type, channel_name, rule_id, rule_name, trigger, target, title, status, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      opts.channelId ?? null,
      opts.channelType ?? null,
      opts.channelName ?? null,
      opts.ruleId ?? null,
      opts.ruleName ?? null,
      opts.trigger,
      opts.target ?? null,
      opts.title != null ? opts.title.slice(0, 2_000) : null,
      opts.status,
      opts.detail != null ? opts.detail.slice(0, 2_000) : null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err }, "dao.recordNotificationDelivery failed");
    return null;
  }
}

/** Bulk insert pattern hits — every pattern-checks / safety-scanner finding. */
export function recordPatternHits(opts: {
  owner: string;
  repo: string;
  reviewId: number | null;
  hits: Array<{
    ruleName: string;
    source: "builtin" | "custom" | "safety";
    fingerprint?: string;
    /** Set only for admin-authored custom rules — the stable join key analytics
     * use so they're never conflated with same-named YAML anti_patterns. */
    customRuleId?: number | null;
  }>;
}): void {
  const db = openDatabase();
  if (!db || opts.hits.length === 0) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO pattern_hits (owner, repo, rule_name, source, fingerprint, review_id, custom_rule_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction((rows: typeof opts.hits) => {
      for (const r of rows) {
        stmt.run(opts.owner, opts.repo, r.ruleName, r.source, r.fingerprint ?? null, opts.reviewId, r.customRuleId ?? null);
      }
    });
    tx(opts.hits);
  } catch (err) {
    logger.debug({ err }, "dao.recordPatternHits failed");
  }
}

// ---------------------------------------------------------------------------
// Durable review queue (schema v5). The crash-safe shadow of the in-memory
// reviewQueue board: every queued/in-flight review is persisted so a restart can
// re-enqueue work that was running when the process died. The job-runner
// (src/realtime/jobs.ts) owns these rows; the live board stays in-memory. All
// best-effort no-ops when the DB is disabled — recovery simply finds nothing.
// ---------------------------------------------------------------------------

/** Durable lifecycle states. `done` rows are deleted (recovery only cares about
 *  unfinished work); `failed`/`dead_letter` are retained for visibility. */
export type ReviewJobState = "queued" | "running" | "done" | "failed" | "dead_letter";

/** A row of the review_jobs table, as stored. */
export interface ReviewJobRow {
  key: string;
  run_id: string;
  owner: string;
  repo: string;
  number: number;
  mode: "full" | "incremental";
  installation_id: number;
  state: ReviewJobState;
  attempts: number;
  last_error: string | null;
  enqueued_at: string;
  updated_at: string;
}

/** Build the canonical durable-job key — must match the in-memory queue key. */
function reviewJobKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

/**
 * Upsert the durable record for a review attempt. Overwrites any prior row for
 * the same PR (PK = key), stamping the caller's `runId` — the token later
 * terminal writes guard on, so a superseded attempt can't finalize the row that
 * replaced it. Best-effort no-op when persistence is disabled.
 */
export function upsertReviewJob(opts: {
  runId: string;
  owner: string;
  repo: string;
  number: number;
  mode: "full" | "incremental";
  installationId: number;
  state: ReviewJobState;
  attempts: number;
  lastError?: string | null;
}): void {
  const db = openDatabase();
  if (!db) return;
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO review_jobs
         (key, run_id, owner, repo, number, mode, installation_id, state, attempts, last_error, enqueued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         run_id = excluded.run_id,
         mode = excluded.mode,
         installation_id = excluded.installation_id,
         state = excluded.state,
         attempts = excluded.attempts,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    ).run(
      reviewJobKey(opts.owner, opts.repo, opts.number),
      opts.runId,
      opts.owner,
      opts.repo,
      opts.number,
      opts.mode,
      opts.installationId,
      opts.state,
      opts.attempts,
      opts.lastError ?? null,
      now,
      now,
    );
  } catch (err) {
    logger.debug({ err }, "dao.upsertReviewJob failed");
  }
}

/**
 * Finalize a durable review job. Guarded on `runId` so only the run that still
 * owns the row can finalize it — a superseded attempt is a silent no-op. A
 * `done` outcome deletes the row (recovery only re-runs unfinished work);
 * `failed`/`dead_letter` update it in place for visibility. Returns true when a
 * row actually transitioned.
 */
export function markReviewJobTerminal(opts: {
  owner: string;
  repo: string;
  number: number;
  runId: string;
  state: "done" | "failed" | "dead_letter";
  lastError?: string | null;
}): boolean {
  const db = openDatabase();
  if (!db) return false;
  const key = reviewJobKey(opts.owner, opts.repo, opts.number);
  try {
    if (opts.state === "done") {
      const info = db.prepare(`DELETE FROM review_jobs WHERE key = ? AND run_id = ?`).run(key, opts.runId);
      return info.changes > 0;
    }
    const info = db
      .prepare(`UPDATE review_jobs SET state = ?, last_error = ?, updated_at = ? WHERE key = ? AND run_id = ?`)
      .run(opts.state, opts.lastError ?? null, new Date().toISOString(), key, opts.runId);
    return info.changes > 0;
  } catch (err) {
    logger.debug({ err }, "dao.markReviewJobTerminal failed");
    return false;
  }
}

/**
 * Delete the durable job for a PR unconditionally (no run_id guard) — the
 * user-driven cancel / PR-closed path, where operator intent overrides whatever
 * run currently owns the row, so boot recovery won't resurrect a review the user
 * deliberately stopped.
 */
export function deleteReviewJob(owner: string, repo: string, number: number): void {
  const db = openDatabase();
  if (!db) return;
  try {
    db.prepare(`DELETE FROM review_jobs WHERE key = ?`).run(reviewJobKey(owner, repo, number));
  } catch (err) {
    logger.debug({ err }, "dao.deleteReviewJob failed");
  }
}

/**
 * Every review job still unfinished (queued or running) — the set boot recovery
 * re-enqueues. Empty when persistence is disabled.
 */
export function listInFlightReviewJobs(): ReviewJobRow[] {
  const db = openDatabase();
  if (!db) return [];
  try {
    return db
      .prepare(`SELECT * FROM review_jobs WHERE state IN ('queued', 'running') ORDER BY enqueued_at ASC`)
      .all() as ReviewJobRow[];
  } catch (err) {
    logger.debug({ err }, "dao.listInFlightReviewJobs failed");
    return [];
  }
}

/**
 * How long a `processing` claim is honored before it's presumed abandoned (the
 * process crashed mid-dispatch). A webhook dispatch only enqueues durable work
 * and returns in milliseconds, so minutes is a very safe margin. Env-tunable.
 */
const DEFAULT_DELIVERY_LEASE_MS = 5 * 60 * 1000;
function deliveryLeaseMs(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_DELIVERY_LEASE_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELIVERY_LEASE_MS;
}

/**
 * Two-phase idempotency lease for a GitHub webhook delivery, keyed by its
 * X-GitHub-Delivery id. Returns true when the caller should process the
 * delivery, false when it is a duplicate to skip.
 *
 * The claim writes a `processing` row; the caller must finalize it:
 *   - `completeWebhookDelivery` on a successful dispatch → marks it `completed`,
 *     so future redeliveries are suppressed as true duplicates;
 *   - `releaseWebhookDelivery` on a failure that produced no result → deletes it,
 *     so a redelivery is reprocessed.
 *
 * Crash safety: if the process dies mid-dispatch (neither finalizer runs), the
 * row is stuck `processing`. A redelivery is then granted the claim again once
 * the lease has gone stale — so a crash can never permanently suppress a
 * redelivery. A `completed` row is always a duplicate; a *fresh* `processing`
 * row (lease not yet expired) is treated as a concurrent/rapid double-delivery
 * and skipped. The whole decision runs in one transaction so two concurrent
 * deliveries can't both win the claim.
 *
 * When persistence is disabled there is nothing to dedupe against, so we return
 * true (process it) — idempotency degrades to the prior at-least-once behavior
 * rather than silently dropping every delivery.
 */
export function claimWebhookDelivery(deliveryId: string): boolean {
  const db = openDatabase();
  if (!db) return true;
  if (!deliveryId) return true;
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const decide = db.transaction((): boolean => {
      // Fast path: a brand-new delivery claims a fresh `processing` lease.
      const inserted = db
        .prepare(`INSERT OR IGNORE INTO processed_deliveries (delivery_id, status, ts) VALUES (?, 'processing', ?)`)
        .run(deliveryId, nowIso);
      if (inserted.changes > 0) return true;

      const row = db
        .prepare(`SELECT status, ts FROM processed_deliveries WHERE delivery_id = ?`)
        .get(deliveryId) as { status: string; ts: string } | undefined;
      if (!row) return true; // raced a delete — treat as claimable
      if (row.status === "completed") return false; // a genuine duplicate

      // status === 'processing': only reclaim if the prior lease has gone stale
      // (the holder crashed). A fresh lease is a concurrent double-delivery.
      const age = nowMs - Date.parse(row.ts);
      if (Number.isFinite(age) && age >= deliveryLeaseMs()) {
        db.prepare(`UPDATE processed_deliveries SET ts = ? WHERE delivery_id = ? AND status = 'processing'`).run(
          nowIso,
          deliveryId,
        );
        return true;
      }
      return false;
    });
    return decide();
  } catch (err) {
    logger.debug({ err }, "dao.claimWebhookDelivery failed");
    return true;
  }
}

/**
 * Mark a claimed delivery `completed` — the success finalizer for
 * `claimWebhookDelivery`. Only after this does a redelivery of the same id
 * short-circuit as a duplicate. Best-effort no-op when persistence is disabled.
 */
export function completeWebhookDelivery(deliveryId: string): void {
  const db = openDatabase();
  if (!db || !deliveryId) return;
  try {
    db.prepare(`UPDATE processed_deliveries SET status = 'completed', ts = ? WHERE delivery_id = ?`).run(
      new Date().toISOString(),
      deliveryId,
    );
  } catch (err) {
    logger.debug({ err }, "dao.completeWebhookDelivery failed");
  }
}

/**
 * Release a claimed-but-not-completed webhook delivery — the failure finalizer
 * for `claimWebhookDelivery` (dispatch threw or returned a 5xx). Deleting the
 * row re-opens the id so a redelivery is processed instead of being suppressed
 * as a duplicate. Best-effort no-op when persistence is disabled.
 */
export function releaseWebhookDelivery(deliveryId: string): void {
  const db = openDatabase();
  if (!db || !deliveryId) return;
  try {
    db.prepare(`DELETE FROM processed_deliveries WHERE delivery_id = ?`).run(deliveryId);
  } catch (err) {
    logger.debug({ err }, "dao.releaseWebhookDelivery failed");
  }
}
