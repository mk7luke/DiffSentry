import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  validateMigrations,
} from "../../src/storage/db.js";

type LedgerRow = { version: number; name: string | null; applied_at: string | null };

function readLedger(db: Database.Database): LedgerRow[] {
  return db
    .prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version")
    .all() as LedgerRow[];
}

describe("MIGRATIONS metadata", () => {
  it("validates: versions start at 1, contiguous, no duplicates", () => {
    expect(() => validateMigrations()).not.toThrow();
  });

  it("LATEST_SCHEMA_VERSION is the highest declared version", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(LATEST_SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
  });
});

describe("applyMigrations idempotency", () => {
  it("running migrations twice leaves the schema_version ledger unchanged", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      applyMigrations(db);
      const firstLedger = readLedger(db);
      const firstVersion = currentSchemaVersion(db);

      // Every declared migration recorded exactly once, in order.
      expect(firstLedger.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(firstLedger.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
      expect(firstVersion).toBe(LATEST_SCHEMA_VERSION);

      // Second run is a no-op: no new ledger rows, identical contents.
      applyMigrations(db);
      const secondLedger = readLedger(db);
      const secondVersion = currentSchemaVersion(db);

      expect(secondLedger).toHaveLength(firstLedger.length);
      expect(secondLedger).toEqual(firstLedger); // versions, names, AND applied_at timestamps unchanged
      expect(secondVersion).toBe(firstVersion);

      // No duplicate ledger rows snuck in for any version.
      const count = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
      expect(count.n).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it("a third run still adds nothing (stable across repeated startups)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      applyMigrations(db);
      const baseline = readLedger(db);
      applyMigrations(db);
      applyMigrations(db);
      expect(readLedger(db)).toEqual(baseline);
    } finally {
      db.close();
    }
  });

  it("creates the additively-migrated tables (e.g. api_tokens, custom_rules)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      applyMigrations(db);
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      for (const t of ["repos", "findings", "api_tokens", "custom_rules", "notification_deliveries"]) {
        expect(tables.has(t), t).toBe(true);
      }
      // The post-step ADD COLUMN was applied idempotently.
      const findingsCols = new Set(
        (db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      expect(findingsCols.has("triaged_by")).toBe(true);
    } finally {
      db.close();
    }
  });
});
