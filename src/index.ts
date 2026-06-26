import "dotenv/config";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { openDatabase } from "./storage/db.js";
import { startNotifications } from "./notify/engine.js";
import { maybeAutoBackfill } from "./cli/auto-backfill.js";
import { logger } from "./logger.js";

const config = loadConfig();
openDatabase(); // initialise SQLite (or no-op when DB_PATH="")
// Start the alert engine: subscribes to the in-process bus and drives the
// weekly digest + budget checker. Harmless when persistence is off (no
// rules/channels to read) — it simply never delivers anything.
startNotifications();
const app = createServer(config);

app.listen(config.port, () => {
  logger.info(
    { port: config.port, provider: config.aiProvider },
    "DiffSentry is running"
  );
  // Seed the dashboard from history on a fresh install (no-op unless the
  // dashboard is on, persistence is enabled, and the DB is empty). Runs in the
  // background so it never delays the listener coming up.
  maybeAutoBackfill();
});
