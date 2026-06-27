import "dotenv/config";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { openDatabase } from "./storage/db.js";
import { startNotifications } from "./notify/engine.js";
import { maybeAutoBackfill } from "./cli/auto-backfill.js";
import { registerProcessHandlers } from "./shutdown.js";
import { logger } from "./logger.js";

const config = loadConfig();
openDatabase(); // initialise SQLite (or no-op when DB_PATH="")
// Start the alert engine: subscribes to the in-process bus and drives the
// weekly digest + budget checker. Harmless when persistence is off (no
// rules/channels to read) — it simply never delivers anything.
startNotifications();
const { app, recover } = createServer(config);

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, provider: config.aiProvider },
    "DiffSentry is running"
  );
  // Seed the dashboard from history on a fresh install (no-op unless the
  // dashboard is on, persistence is enabled, and the DB is empty). Runs in the
  // background so it never delays the listener coming up.
  maybeAutoBackfill();
  // Re-enqueue any review jobs that were in-flight when we last stopped, so a
  // restart (deploy, crash) resumes interrupted reviews. No-op when persistence
  // is disabled or nothing was pending. Fire-and-forget — never blocks the boot.
  const recovered = recover();
  if (recovered > 0) logger.info({ recovered }, "Re-enqueued in-flight reviews after restart");
});

// Crash safety (unhandledRejection/uncaughtException → log + exit non-zero) and
// graceful shutdown (SIGTERM/SIGINT → drain HTTP, cancel reviews, flush+close
// the DB, then exit 0 with a hard timeout backstop). All steps no-op cleanly
// when persistence is disabled (DB_PATH="").
registerProcessHandlers(server);
