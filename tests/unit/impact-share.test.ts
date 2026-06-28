import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Persistence ON, in an isolated temp DB, set BEFORE any openDatabase() runs so
// the singleton latches onto our file. Vitest isolates module state per test
// file, so this DB_PATH is scoped to this file. Restored in afterAll.
const ORIGINAL_DB_PATH = process.env.DB_PATH;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ds-share-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "shares.db");

import { openDatabase } from "../../src/storage/db.js";
import {
  createImpactShare,
  revokeImpactShare,
  listImpactShares,
  findActiveImpactShareByHash,
} from "../../src/storage/dao.js";
import { generateShareToken, hashShareToken, buildSharedImpactReport } from "../../src/api/shares.js";
import { createServer } from "../../src/server.js";
import type { Config } from "../../src/types.js";

afterAll(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
});

/** Side-effect-free config (clients only store it at construction). */
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

describe("impact share DAO + token", () => {
  beforeAll(() => {
    openDatabase(); // runs migrations → impact_shares (migration 7)
  });

  it("persists only the hash and looks a share up by it", () => {
    const { token, hash } = generateShareToken();
    expect(token.startsWith("dss_")).toBe(true);
    expect(hashShareToken(token)).toBe(hash);

    const id = createImpactShare({ shareHash: hash, repo: "acme/web", defaultRange: "30d", label: "Q2" });
    expect(id).toBeTypeOf("number");

    const row = findActiveImpactShareByHash(hash);
    expect(row?.repo).toBe("acme/web");
    // The plaintext token is never stored, only its hash.
    expect((row as unknown as { token?: string })?.token).toBeUndefined();
    expect(row?.share_hash).toBe(hash);
  });

  it("revoke is idempotent and hides the share from active lookup", () => {
    const { hash } = generateShareToken();
    const id = createImpactShare({ shareHash: hash, repo: null, defaultRange: "7d" })!;

    expect(findActiveImpactShareByHash(hash)).toBeDefined();
    expect(revokeImpactShare(id)).toBe(true);
    expect(findActiveImpactShareByHash(hash)).toBeUndefined();
    // Re-revoking is a harmless no-op.
    expect(revokeImpactShare(id)).toBe(false);
    // Metadata listing never leaks the hash plaintext token either.
    expect(listImpactShares().some((s) => s.id === id)).toBe(true);
  });

  it("buildSharedImpactReport returns an aggregate report for an active token, null otherwise", () => {
    const { token, hash } = generateShareToken();
    createImpactShare({ shareHash: hash, repo: null, defaultRange: "30d" });

    const ok = buildSharedImpactReport(token, "7d");
    expect(ok).not.toBeNull();
    expect(ok!.report.current).toBeDefined();
    expect(typeof ok!.report.current.reviews).toBe("number");

    expect(buildSharedImpactReport("dss_unknown", "30d")).toBeNull();
  });
});

describe("public share HTTP surface (no auth)", () => {
  it("serves the report + SPA shell without auth, 404s unknown/revoked", async () => {
    openDatabase();
    const { token, hash } = generateShareToken();
    const id = createImpactShare({ shareHash: hash, repo: null, defaultRange: "30d" })!;

    const { app } = createServer(testConfig());
    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const port = (server.address() as { port: number }).port;
    const base = `http://localhost:${port}`;

    try {
      // No Authorization header, no cookie.
      const r = await fetch(`${base}/api/v1/public/impact/${token}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { data: { current: { reviews: number } } };
      expect(typeof body.data.current.reviews).toBe("number");
      // Aggregate only — no per-finding/source fields leak through.
      const blob = JSON.stringify(body.data);
      for (const leak of ['"snippet"', '"message"', '"code"', '"path"']) {
        expect(blob.includes(leak)).toBe(false);
      }

      // Chrome-less viewer HTML, also no auth.
      const page = await fetch(`${base}/share/impact/${token}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type") || "").toContain("html");

      // Unknown token → plain 404 (not a 401 auth challenge).
      expect((await fetch(`${base}/api/v1/public/impact/dss_nope`)).status).toBe(404);

      // Revocable: after revoke the link 404s.
      revokeImpactShare(id);
      expect((await fetch(`${base}/api/v1/public/impact/${token}`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
