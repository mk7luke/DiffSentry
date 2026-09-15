import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createRouter } from "./router.js";
import { Store } from "./store.js";
import { runWorker } from "./worker.js";
import { scheduleArchiving } from "./archive/index.js";

const config = loadConfig(process.env);
const store = new Store();
const router = createRouter(store);

const server = createServer(router);
server.listen(config.port, () => {
  console.log(`[reports] listening on :${config.port} (log level ${config.logLevel})`);
});

const WORKER_INTERVAL_MS = 60 * 60 * 1000; // hourly
setInterval(() => runWorker(store, Date.now, config.retentionMs), WORKER_INTERVAL_MS);

scheduleArchiving(store, config.archiveBucket, config.archiveRegion);
