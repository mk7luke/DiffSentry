/**
 * Dashboard self-seed on boot.
 *
 * When the dashboard is enabled (ENABLE_DASHBOARD=1) and persistence is on but
 * the database has no repos/PRs yet, a brand-new install would show an empty
 * dashboard until the first webhook arrives — a silent "is it even working?"
 * trap. This kicks off the existing one-time backfill (the same logic the
 * `backfill` CLI runs) automatically so the dashboard has data on first visit.
 *
 * Lower-risk by design:
 *   - No-op unless ENABLE_DASHBOARD=1.
 *   - No-op when persistence is disabled (DB_PATH="") — openDatabase() returns
 *     null and we return immediately.
 *   - Only runs when the DB is empty, so it never re-scrapes on every restart
 *     and never competes with live webhook-driven writes once data exists.
 *   - Runs in the background (not awaited) so it never delays the HTTP listener.
 *   - Swallows all errors (rate limits, auth) into a warning — a failed seed
 *     must never crash boot; the dashboard simply populates as webhooks arrive.
 */
import { openDatabase } from "../storage/db.js";
import { logger } from "../logger.js";
import { runBackfill } from "./backfill.js";

/** True when the DB has no repos and no PRs recorded yet. */
function databaseIsEmpty(db: import("better-sqlite3").Database): boolean {
  const row = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM repos) + (SELECT COUNT(*) FROM prs) AS n",
    )
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) === 0;
}

/**
 * Fire-and-forget. Returns immediately; any actual backfill runs in the
 * background. Safe to call unconditionally on boot.
 */
export function maybeAutoBackfill(): void {
  if (process.env.ENABLE_DASHBOARD !== "1") return;

  // openDatabase() returns null when persistence is disabled — the no-op case.
  const db = openDatabase();
  if (!db) return;

  let empty: boolean;
  try {
    empty = databaseIsEmpty(db);
  } catch (err) {
    logger.warn({ err }, "auto-backfill: could not check whether the DB is empty; skipping");
    return;
  }
  if (!empty) return;

  logger.info("Dashboard enabled with an empty database — seeding it with a one-time backfill in the background");
  void runBackfill()
    .then(({ totalRepos, totalPRs }) =>
      logger.info({ totalRepos, totalPRs }, "auto-backfill: dashboard seeded"),
    )
    .catch((err) =>
      logger.warn(
        { err },
        "auto-backfill failed; the dashboard will populate as new webhooks arrive (run `npm run backfill` to retry)",
      ),
    );
}
