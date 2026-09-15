import type { Store } from "../store.js";
import { archiveReports } from "./archiveReports.js";
import { createArchiveClient } from "./s3Client.js";

const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000; // hourly, alongside the retention sweep

/** Starts the periodic archival job. Returns the timer so callers can stop it in tests. */
export function scheduleArchiving(store: Store, bucket: string, region: string): NodeJS.Timeout {
  const client = createArchiveClient(region);
  return setInterval(() => {
    void archiveReports(store.all(), bucket, client);
  }, ARCHIVE_INTERVAL_MS);
}
