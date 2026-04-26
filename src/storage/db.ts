import path from "node:path";
import fs from "node:fs";
import Database, { Database as DB } from "better-sqlite3";
import { logger } from "../logger.js";

let _db: DB | null = null;
let _disabled = false;

const SCHEMA_VERSION = 1;

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
    db.exec(SCHEMA_V1);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined;
    if (!row) {
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }
    _db = db;
    logger.info({ dbPath }, "SQLite persistence opened");
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
