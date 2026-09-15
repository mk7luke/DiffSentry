import { describe, expect, it, vi } from "vitest";
import { archiveReports } from "../../src/archive/archiveReports.js";
import type { ArchiveClient } from "../../src/archive/s3Client.js";
import type { Report } from "../../src/store.js";

function report(id: number, ownerId: string): Report {
  return { id, ownerId, title: `r${id}`, body: "x", createdAt: Date.now() };
}

describe("archiveReports", () => {
  it("uploads one manifest per owner", async () => {
    const putObject = vi.fn(async () => {});
    const client: ArchiveClient = { putObject };

    const uploaded = await archiveReports([report(1, "a"), report(2, "a"), report(3, "b")], "bucket", client);

    expect(uploaded).toBe(2);
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(putObject).toHaveBeenCalledWith(expect.objectContaining({ bucket: "bucket", key: "a/manifest.txt" }));
    expect(putObject).toHaveBeenCalledWith(expect.objectContaining({ bucket: "bucket", key: "b/manifest.txt" }));
  });

  it("uploads nothing for an empty report list", async () => {
    const putObject = vi.fn(async () => {});
    const uploaded = await archiveReports([], "bucket", { putObject });
    expect(uploaded).toBe(0);
    expect(putObject).not.toHaveBeenCalled();
  });
});
