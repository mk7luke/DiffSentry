/**
 * Smoke-test the migration runner.
 * Run: npx tsx scripts/migrate-smoke.ts  (or: npm run smoke:migrate)
 *
 * Covers the acceptance criteria:
 *   1. A fresh DB migrates cleanly to the latest version.
 *   2. Running the runner twice is a no-op (idempotent).
 *   3. An existing v1 DB (single-column schema_version) upgrades in place
 *      without losing data, and gains the new triage columns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { applyMigrations, currentSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/storage/db.js";

let counter = 0;
function tmpPath(): string {
  // No Date.now()/Math.random() needed — a process-local counter is enough.
  return path.join(os.tmpdir(), `ds-migrate-smoke-${process.pid}-${counter++}.db`);
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

const EXPECTED_V2_TABLES = [
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
const EXPECTED_TRIAGE_COLS = ["accepted", "snoozed_until", "triaged_by", "triaged_at", "triage_note"];

function withDb(file: string, fn: (db: Database.Database) => void): void {
  const db = new Database(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function cleanup(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + suffix, { force: true });
    } catch {
      // ignore
    }
  }
}

// --- 1 & 2: fresh DB + idempotency -----------------------------------------
function testFreshAndIdempotent(): void {
  const file = tmpPath();
  try {
  withDb(file, (db) => {
    applyMigrations(db);
    assert.equal(currentSchemaVersion(db), LATEST_SCHEMA_VERSION, "fresh DB should reach latest version");

    const tables = tableNames(db);
    for (const t of ["repos", "prs", "reviews", "findings", "events", "issues", ...EXPECTED_V2_TABLES]) {
      assert.ok(tables.has(t), `expected table ${t} to exist`);
    }
    const findingsCols = columnNames(db, "findings");
    for (const c of EXPECTED_TRIAGE_COLS) {
      assert.ok(findingsCols.has(c), `expected findings.${c} to exist`);
    }

    const ledgerBefore = db.prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version").all();
    assert.equal(ledgerBefore.length, MIGRATIONS.length, "ledger should have one row per migration");
    for (const row of ledgerBefore as Array<{ name: string; applied_at: string }>) {
      assert.ok(row.name, "ledger row should record a name");
      assert.ok(row.applied_at, "ledger row should record applied_at");
    }

    // Idempotency: run twice more, expect no change to the ledger.
    applyMigrations(db);
    applyMigrations(db);
    const ledgerAfter = db.prepare("SELECT version, name FROM schema_version ORDER BY version").all();
    assert.deepEqual(
      ledgerAfter,
      ledgerBefore.map((r) => ({ version: (r as { version: number }).version, name: (r as { name: string }).name })),
      "re-running migrations must not add or change ledger rows",
    );
  });
  console.log("ok  fresh DB migrates to latest + idempotent re-run");
  } finally {
    cleanup(file);
  }
}

// --- 3: existing v1 DB upgrades in place -----------------------------------
function testExistingV1Upgrade(): void {
  const file = tmpPath();
  try {
  // Simulate a DB created by the OLD code: legacy single-column schema_version
  // plus the v1 baseline tables, with a real findings row to protect.
  withDb(file, (db) => {
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    db.exec(MIGRATIONS[0].sql); // v1 baseline (CREATE IF NOT EXISTS, safe)
    db.prepare(
      `INSERT INTO reviews (owner, repo, number, sha, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("acme", "widgets", 1, "deadbeef", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO findings (review_id, path, severity, title, accepted) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, "src/x.ts", "critical", "Pre-existing finding", 1);
  });

  withDb(file, (db) => {
    assert.equal(currentSchemaVersion(db), 1, "legacy DB should report version 1 before upgrade");
    applyMigrations(db);
    assert.equal(currentSchemaVersion(db), LATEST_SCHEMA_VERSION, "legacy DB should upgrade to latest");

    // New tables + triage columns present.
    const tables = tableNames(db);
    for (const t of EXPECTED_V2_TABLES) assert.ok(tables.has(t), `expected table ${t} after upgrade`);
    const findingsCols = columnNames(db, "findings");
    for (const c of EXPECTED_TRIAGE_COLS) assert.ok(findingsCols.has(c), `expected findings.${c} after upgrade`);

    // Pre-existing data survived untouched.
    const finding = db.prepare("SELECT title, accepted, snoozed_until FROM findings WHERE id = 1").get() as {
      title: string;
      accepted: number;
      snoozed_until: string | null;
    };
    assert.equal(finding.title, "Pre-existing finding", "existing finding data must survive");
    assert.equal(finding.accepted, 1, "existing accepted flag must survive");
    assert.equal(finding.snoozed_until, null, "new column defaults to NULL");

    // Ledger now has both versions, and the legacy row got backfilled columns.
    const ledger = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(ledger.map((r) => r.version), MIGRATIONS.map((m) => m.version), "ledger has all versions");
  });
  console.log("ok  existing v1 DB upgrades in place without data loss");
  } finally {
    cleanup(file);
  }
}

// --- 4: migration 2 tolerates a pre-existing triage column -----------------
function testPreExistingTriageColumn(): void {
  const file = tmpPath();
  try {
  // A v1 DB where someone already hand-added one of the triage columns. The
  // plain ALTER would throw "duplicate column"; the guarded `post` step must
  // skip it and add only the missing ones.
  withDb(file, (db) => {
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    db.exec(MIGRATIONS[0].sql);
    db.exec("ALTER TABLE findings ADD COLUMN snoozed_until TEXT"); // pre-existing
  });

  withDb(file, (db) => {
    applyMigrations(db); // must not throw on the duplicate column
    assert.equal(currentSchemaVersion(db), LATEST_SCHEMA_VERSION, "should still reach latest");
    const cols = columnNames(db, "findings");
    for (const c of EXPECTED_TRIAGE_COLS) assert.ok(cols.has(c), `expected findings.${c}`);
  });
  console.log("ok  migration 2 skips a pre-existing triage column (idempotent ADD COLUMN)");
  } finally {
    cleanup(file);
  }
}

testFreshAndIdempotent();
testExistingV1Upgrade();
testPreExistingTriageColumn();
console.log(`\nAll migration smoke tests passed (latest schema version = ${LATEST_SCHEMA_VERSION}).`);
