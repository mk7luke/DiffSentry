import "dotenv/config";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { openDatabase } from "./storage/db.js";
import { logger } from "./logger.js";

const config = loadConfig();
openDatabase(); // initialise SQLite (or no-op when DB_PATH="")
const app = createServer(config);

app.listen(config.port, () => {
  logger.info(
    { port: config.port, provider: config.aiProvider },
    "DiffSentry is running"
  );
});
