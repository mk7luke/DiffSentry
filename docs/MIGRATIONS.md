# Database migrations

DiffSentry's SQLite schema is managed by a small ordered migration runner in
[`src/storage/db.ts`](../src/storage/db.ts). There is no external migration
tool — migrations are plain SQL strings applied in order at startup.

## How it works

- `MIGRATIONS` is an ordered array of `{ version, name, sql }`. Each entry is
  applied **in array order, inside its own transaction**. If a migration's SQL
  fails, that transaction rolls back and startup aborts — the database is never
  left half-migrated.
- Applied versions are tracked in the `schema_version` table, which is a
  **ledger**: one row per applied migration recording `version`, `name`, and
  `applied_at`. Rows are not limited to migrations this binary knows about — a
  database that briefly ran a newer binary keeps those future rows after a
  rollback (they are preserved, never downgraded; see the no-downgrade note
  below).
- `applyMigrations(db)` runs every pending migration. It is **idempotent**:
  already-applied versions are skipped, so running it twice is a no-op.
  `openDatabase()` calls it automatically.
- **Never auto-downgrades.** If the database's max version is higher than the
  binary knows about (`LATEST_SCHEMA_VERSION`), the runner logs a warning and
  never drops the future rows. It still applies any *supported* versions the
  ledger is missing, so a future row can't block a known pending migration.
- Each applied migration is logged at `info` level (`Applied schema migration`).

### Legacy databases

Databases created before the runner existed have a single-column
`schema_version (version INTEGER PRIMARY KEY)` table with a row `version = 1`.
On first start with the new code, the runner adds the missing `name` and
`applied_at` columns in place, treats version 1 as already applied (so the v1
baseline is not re-run), and applies migration 2 onward. No data is touched.

## Current migrations

| Version | Name             | What it adds                                                                 |
| ------- | ---------------- | ---------------------------------------------------------------------------- |
| 1       | `v1_baseline`    | Original schema: `repos`, `prs`, `reviews`, `findings`, `events`, `pattern_hits`, `issues`. Idempotent `CREATE IF NOT EXISTS`. |
| 2       | `command_center` | Command-center tables (`audit_log`, `settings_overrides`, `api_tokens`, `cost_events`, `notification_channels`, `alert_rules`, `saved_views`, `webhook_deliveries`, `roles`) and the `findings` triage columns (`snoozed_until`, `triaged_by`, `triaged_at`, `triage_note`). |

## Adding a migration

1. Append a new entry to `MIGRATIONS` with the **next contiguous version**.
   Never edit, reorder, or delete an already-released migration — write a new
   one that alters state forward.
2. Keep it **additive**: prefer `CREATE TABLE IF NOT EXISTS`. SQLite's `ADD
   COLUMN` has no `IF NOT EXISTS`, so for column adds use the optional `post`
   hook on the migration — a `(db) => void` run inside the same transaction
   after the SQL — and guard each add against `PRAGMA table_info` (see
   `ensureFindingsTriageColumns` in migration 2). That stays idempotent even if
   a column already exists.
3. Run the smoke test: `npm run smoke:migrate`. It verifies a fresh DB reaches
   the latest version, that re-running is a no-op, and that an existing v1 DB
   upgrades in place without data loss
   ([`scripts/migrate-smoke.ts`](../scripts/migrate-smoke.ts)).

## Disabling persistence

Setting `DB_PATH=""` (explicitly empty) disables SQLite entirely;
`openDatabase()` returns `null` and every DAO write becomes a no-op. The
migration runner only runs when a database is actually opened.
