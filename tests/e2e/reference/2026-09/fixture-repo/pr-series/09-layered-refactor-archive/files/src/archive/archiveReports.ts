import _ from "lodash";
import type { Report } from "../store.js";
import type { ArchiveClient } from "./s3Client.js";

/**
 * Ships a text manifest of every owner's reports to cold storage, one
 * object per owner so a support engineer can pull a single owner's
 * history without downloading everything.
 */
export async function archiveReports(reports: Report[], bucket: string, client: ArchiveClient): Promise<number> {
  const byOwner = _.groupBy(reports, (r) => r.ownerId);
  let uploaded = 0;
  for (const [owner, ownerReports] of Object.entries(byOwner)) {
    const manifest = ownerReports.map((r) => `${r.id}\t${r.title}`).join("\n");
    await client.putObject({
      bucket,
      key: `${owner}/manifest.txt`,
      body: Buffer.from(manifest, "utf8"),
    });
    uploaded += 1;
  }
  return uploaded;
}
