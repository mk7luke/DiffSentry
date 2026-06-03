import path from "node:path";
import fs from "node:fs";
import Database, { Database as DB } from "better-sqlite3";
import { logger } from "../logger.js";

let _db: DB | null = null;
let _disabled = false;

/**
 * Migration 1 — the original v1 schema. Kept verbatim and idempotent
 * (CREATE TABLE IF NOT EXISTS) so existing databases that already carry these
 * tables skip it cleanly, and fresh databases get the full baseline.
 *
 * Note: the runner bootstraps an extended `schema_version` ledger before any
 * migration runs, so the bare `schema_version` CREATE below is a harmless
 * no-op (the table already exists with extra columns).
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS repos (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (owner, repo)
);

CREATE TABLE IF NOT EXISTS prs (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  state TEXT,
  base_sha TEXT,
  head_sha TEXT,
  created_at TEXT,
  closed_at TEXT,
  merged_at TEXT,
  PRIMARY KEY (owner, repo, number)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  sha TEXT NOT NULL,
  run_id TEXT,
  profile TEXT,
  approval TEXT,
  summary TEXT,
  risk_score INTEGER,
  risk_level TEXT,
  files_processed INTEGER,
  files_skipped_similar INTEGER,
  files_skipped_trivial INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(owner, repo, number);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  path TEXT,
  line INTEGER,
  type TEXT,
  severity TEXT,
  title TEXT,
  body TEXT,
  fingerprint TEXT,
  source TEXT,
  confidence TEXT,
  accepted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);
CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_pr ON events(owner, repo, number);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS pattern_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  source TEXT NOT NULL,
  fingerprint TEXT,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pattern_rule ON pattern_hits(rule_name);

CREATE TABLE IF NOT EXISTS issues (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  author TEXT,
  state TEXT,
  body TEXT,
  url TEXT,
  labels_json TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_action_at TEXT,
  last_action_kind TEXT,
  action_count INTEGER NOT NULL DEFAULT 0,
  last_summary TEXT,
  last_plan TEXT,
  PRIMARY KEY (owner, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_last_action ON issues(owner, repo, last_action_at DESC);
`;

/**
 * Migration 2 — command-center storage. Everything the team-facing dashboard
 * needs: audit trail, settings overrides, API tokens, cost tracking,
 * notification/alerting config, saved views, raw webhook deliveries, the
 * triage model on findings, and an optional role override store.
 *
 * Strictly additive: new tables (IF NOT EXISTS) here, plus the findings triage
 * columns added idempotently in the `post` step (ensureFindingsTriageColumns).
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_login TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_ref TEXT,
  payload_json TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_login);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

CREATE TABLE IF NOT EXISTS settings_overrides (
  scope TEXT NOT NULL,            -- 'global' | 'owner/repo'
  key TEXT NOT NULL,
  value_json TEXT,
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  token_hash TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT,
  last_used_at TEXT,
  scopes_json TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  owner TEXT,
  repo TEXT,
  number INTEGER,
  review_id INTEGER,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_ts ON cost_events(ts);
CREATE INDEX IF NOT EXISTS idx_cost_repo ON cost_events(owner, repo);
CREATE INDEX IF NOT EXISTS idx_cost_review ON cost_events(review_id);

CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- slack | discord | email | webhook
  name TEXT,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  scope TEXT,
  condition_json TEXT,
  channel_id INTEGER REFERENCES notification_channels(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_channel ON alert_rules(channel_id);

CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_login TEXT,
  name TEXT,
  route TEXT,
  query_json TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views(owner_login);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT,
  action TEXT,
  owner TEXT,
  repo TEXT,
  number INTEGER,
  delivery_id TEXT,
  signature_ok INTEGER,
  payload_json TEXT,
  replayed_from INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_ts ON webhook_deliveries(ts);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery ON webhook_deliveries(delivery_id);

CREATE TABLE IF NOT EXISTS roles (
  login TEXT PRIMARY KEY,
  role TEXT,
  granted_by TEXT,
  granted_at TEXT
);
`;
// The findings triage columns are added by ensureFindingsTriageColumns() in
// migration 2's `post` step — SQLite ADD COLUMN has no IF NOT EXISTS, so we
// guard each add against PRAGMA table_info to stay idempotent.

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Optional programmatic step run inside the same transaction, immediately
   * after `sql` and before the ledger row is written. Use for changes plain
   * SQL can't express idempotently (e.g. conditional ADD COLUMN).
   */
  post?: (db: DB) => void;
}

/**
 * Idempotently add the findings triage columns. SQLite's ALTER TABLE ADD
 * COLUMN has no IF NOT EXISTS, so we inspect the current columns and add only
 * the missing ones. Column names are fixed literals (no user input).
 */
function ensureFindingsTriageColumns(db: DB): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const additions: Array<[string, string]> = [
    ["snoozed_until", "TEXT"],
    ["triaged_by", "TEXT"],
    ["triaged_at", "TEXT"],
    ["triage_note", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!cols.has(name)) db.exec(`ALTER TABLE findings ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Ordered migration set. Applied in array order inside a transaction each, and
 * tracked in the `schema_version` ledger by version number. Append new
 * migrations here with the next contiguous version — never edit or reorder an
 * already-released one.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "v1_baseline", sql: SCHEMA_V1 },
  { version: 2, name: "command_center", sql: SCHEMA_V2, post: ensureFindingsTriageColumns },
];

/** Highest version this binary knows how to migrate to. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

/**
 * Ensure `schema_version` exists as a ledger: one row per applied migration,
 * recording the version, its name, and when it was applied. Existing v1
 * databases carry a single-column `schema_version (version)` table — we add
 * the missing columns in place so the ledger shape is uniform.
 */
function ensureLedger(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       name TEXT,
       applied_at TEXT
     )`,
  );
  const cols = new Set(
    (db.prepare("PRAGMA table_info(schema_version)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("name")) db.exec("ALTER TABLE schema_version ADD COLUMN name TEXT");
  if (!cols.has("applied_at")) db.exec("ALTER TABLE schema_version ADD COLUMN applied_at TEXT");
}

/** Versions already recorded as applied. */
function appliedVersions(db: DB): Set<number> {
  const rows = db.prepare("SELECT version FROM schema_version").all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/** Current schema version (max applied), or 0 for a brand-new database. */
export function currentSchemaVersion(db: DB): number {
  ensureLedger(db);
  const versions = appliedVersions(db);
  return versions.size === 0 ? 0 : Math.max(...versions);
}

/**
 * Apply every pending migration in order. Each runs in its own transaction so
 * a failure rolls back that migration only; the ledger row is written in the
 * same transaction. Idempotent: already-applied versions are skipped, so
 * running twice is a no-op. Never downgrades — if the database is ahead of
 * this binary we log and leave it untouched.
 */
export function applyMigrations(db: DB): void {
  ensureLedger(db);
  const applied = appliedVersions(db);

  const dbVersion = applied.size === 0 ? 0 : Math.max(...applied);
  if (dbVersion > LATEST_SCHEMA_VERSION) {
    logger.warn(
      { dbVersion, supported: LATEST_SCHEMA_VERSION },
      "Database schema is newer than this binary — refusing to downgrade, leaving as-is",
    );
    return;
  }

  const insertLedger = db.prepare(
    "INSERT OR REPLACE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      migration.post?.(db);
      insertLedger.run(migration.version, migration.name, new Date().toISOString());
    });
    run();
    logger.info({ version: migration.version, name: migration.name }, "Applied schema migration");
  }
}

/**
 * Open (or create) the SQLite database. Honors the DB_PATH env var; an
 * empty value disables persistence entirely (the dao becomes a no-op).
 * Default path: ./data/diffsentry.db.
 */
export function openDatabase(): DB | null {
  if (_disabled) return null;
  if (_db) return _db;
  const raw = process.env.DB_PATH;
  if (raw === "") {
    _disabled = true;
    logger.info("DB_PATH explicitly empty — persistence disabled");
    return null;
  }
  const dbPath = raw && raw.trim().length > 0 ? raw : path.resolve(process.cwd(), "data/diffsentry.db");
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    _db = db;
    logger.info({ dbPath, schemaVersion: currentSchemaVersion(db) }, "SQLite persistence opened");
    return db;
  } catch (err) {
    logger.warn({ err, dbPath }, "Failed to open SQLite — persistence disabled");
    _disabled = true;
    return null;
  }
}

export function closeDatabase(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore
    }
    _db = null;
  }
}
