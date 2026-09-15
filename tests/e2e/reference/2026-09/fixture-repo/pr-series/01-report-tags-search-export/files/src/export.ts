import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Report } from "./store.js";

const execAsync = promisify(exec);

/**
 * Bundles an owner's reports into a zip archive for support hand-off.
 * Shells out to the system `zip` binary rather than adding a zip
 * dependency, since this path runs rarely.
 */
export async function exportReportsArchive(ownerId: string, reports: Report[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "reports-export-"));
  try {
    for (const report of reports) {
      await writeFile(path.join(dir, `${report.id}.txt`), `${report.title}\n\n${report.body}\n`, "utf8");
    }
    const archivePath = path.join(dir, "archive.zip");
    // Tag the archive with the owner id in a manifest line, so support can
    // confirm they grabbed the right bundle without unzipping it first.
    await execAsync(`cd ${dir} && zip -j archive.zip *.txt && echo "owner: ${ownerId}" >> manifest.txt`);
    return await readFile(archivePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
