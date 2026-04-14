import "dotenv/config";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logger } from "./logger.js";

const config = loadConfig();
const app = createServer(config);

app.listen(config.port, () => {
  logger.info(
    { port: config.port, provider: config.aiProvider },
    "DiffSentry is running"
  );
});
