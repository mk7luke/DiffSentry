import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";

// Disable persistence before any openDatabase() runs (createServer →
// applyPersistedSettings / recover touch the DB). With DB_PATH="" the singleton
// latches disabled, so recover() exercises the no-op path. Restored in afterAll.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
process.env.DB_PATH = "";

import { createServer } from "../../src/server.js";
import type { Config } from "../../src/types.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

/** A minimal, side-effect-free config: the AI/GitHub clients only store it at
 *  construction, so no network happens. ENABLE_DASHBOARD is unset, so only the
 *  /webhook + /health routes mount. */
function testConfig(): Config {
  return {
    port: 0,
    githubAppId: "1",
    githubPrivateKey: "test-key",
    githubWebhookSecret: "secret",
    aiProvider: "openai-compatible",
    anthropicModel: "m",
    openaiModel: "m",
    localAiBaseUrl: "http://localhost:1",
    localAiApiKey: "sk-test",
    localAiModel: "m",
    localAiJsonMode: false,
    maxFilesPerReview: 10,
    ignoredPatterns: [],
    botName: "diffsentry",
    learningsDir: os.tmpdir(),
  };
}

describe("createServer contract", () => {
  it("returns a { app, recover } struct — NOT a bare Express app", () => {
    const created = createServer(testConfig());

    // The struct contract: both members present and correctly shaped.
    expect(created).toHaveProperty("app");
    expect(created).toHaveProperty("recover");
    expect(typeof created.recover).toBe("function");

    // Guard against the exact misuse the contract is meant to prevent: the bundle
    // itself is not an Express app — `.listen()` lives on `app`, not the return.
    expect((created as unknown as { listen?: unknown }).listen).toBeUndefined();
    expect(typeof created.app.listen).toBe("function");
  });

  it("destructures { app, recover }; app.listen() works and recover() runs after startup", async () => {
    const { app, recover } = createServer(testConfig());

    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    // recover() is the boot hook index.ts calls inside the listen callback. With
    // persistence disabled it is a no-op and returns 0 (nothing to re-enqueue).
    const recovered = recover();
    expect(recovered).toBe(0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
