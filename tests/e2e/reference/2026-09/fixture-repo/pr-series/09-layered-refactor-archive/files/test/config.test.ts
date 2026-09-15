import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults the archive bucket and region", () => {
    const config = loadConfig({});
    expect(config.archiveBucket).toBe("reports-archive");
    expect(config.archiveRegion).toBe("us-east-1");
  });

  it("reads the archive bucket and region from the environment", () => {
    const config = loadConfig({ ARCHIVE_BUCKET: "custom-bucket", ARCHIVE_REGION: "eu-west-1" });
    expect(config.archiveBucket).toBe("custom-bucket");
    expect(config.archiveRegion).toBe("eu-west-1");
  });
});
