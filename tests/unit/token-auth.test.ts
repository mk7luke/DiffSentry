import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Point persistence at a throwaway file BEFORE any module opens the db
// singleton, so the round-trip auth tests exercise the real storage path.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diffsentry-tokenauth-"));
process.env.DB_PATH = path.join(tmpDir, "tokens.db");

const {
  API_SCOPES,
  TOKEN_PREFIX,
  authenticateBearer,
  canonicalizeStoredScopes,
  extractBearer,
  generateApiToken,
  hashApiToken,
  isApiScope,
  normalizeScopes,
  requiredScopeForMethod,
} = await import("../../src/api/token-auth.js");
const { createApiToken, revokeApiToken } = await import("../../src/storage/dao.js");
const { closeDatabase } = await import("../../src/storage/db.js");

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashApiToken", () => {
  it("is a deterministic SHA-256 hex of the token", () => {
    const token = "dsk_example-token";
    const expected = crypto.createHash("sha256").update(token).digest("hex");
    expect(hashApiToken(token)).toBe(expected);
    expect(hashApiToken(token)).toBe(hashApiToken(token));
    expect(hashApiToken(token)).toHaveLength(64);
  });

  it("differs for different tokens", () => {
    expect(hashApiToken("dsk_a")).not.toBe(hashApiToken("dsk_b"));
  });
});

describe("generateApiToken", () => {
  it("mints a prefixed token whose hash matches hashApiToken", () => {
    const { token, hash } = generateApiToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(hash).toBe(hashApiToken(token));
  });

  it("mints distinct tokens each call", () => {
    expect(generateApiToken().token).not.toBe(generateApiToken().token);
  });
});

describe("extractBearer", () => {
  it("pulls the credential from a Bearer header (case-insensitive)", () => {
    expect(extractBearer("Bearer dsk_abc")).toBe("dsk_abc");
    expect(extractBearer("bearer   dsk_abc  ")).toBe("dsk_abc");
  });

  it("returns null for absent or non-Bearer headers", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("dsk_abc")).toBeNull();
  });
});

describe("scope normalization", () => {
  it("normalizeScopes dedupes, applies review⇒read, and defaults to read", () => {
    expect(normalizeScopes(["review", "review"])).toEqual(["read", "review"]);
    expect(normalizeScopes([])).toEqual(["read"]);
    expect(normalizeScopes(["garbage"])).toEqual(["read"]); // never minted useless
    expect(normalizeScopes("not-an-array")).toEqual(["read"]);
  });

  it("canonicalizeStoredScopes fails safe — no implicit read default", () => {
    expect(canonicalizeStoredScopes(["review"])).toEqual(["read", "review"]);
    expect(canonicalizeStoredScopes([])).toEqual([]); // corrupt/empty → no scopes
    expect(canonicalizeStoredScopes(["garbage"])).toEqual([]);
    expect(canonicalizeStoredScopes(null)).toEqual([]);
  });

  it("isApiScope guards the known set", () => {
    expect(API_SCOPES.every(isApiScope)).toBe(true);
    expect(isApiScope("admin")).toBe(false);
  });
});

describe("requiredScopeForMethod", () => {
  it("reads need read, writes need review", () => {
    expect(requiredScopeForMethod("GET")).toBe("read");
    expect(requiredScopeForMethod("HEAD")).toBe("read");
    expect(requiredScopeForMethod("POST")).toBe("review");
    expect(requiredScopeForMethod("DELETE")).toBe("review");
    expect(requiredScopeForMethod("PATCH")).toBe("review");
  });
});

describe("authenticateBearer + scope enforcement (round-trip through storage)", () => {
  // Mirrors the gate in src/api/router.ts: principal.scopes.includes(needed).
  const allowed = (scopes: readonly string[], method: string) =>
    scopes.includes(requiredScopeForMethod(method));

  it("returns null for an unknown token", () => {
    expect(authenticateBearer("dsk_does-not-exist")).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(authenticateBearer("")).toBeNull();
  });

  it("authenticates a read-only token: read allowed, review denied", () => {
    const { token, hash } = generateApiToken();
    const id = createApiToken({ name: "reader", tokenHash: hash, scopes: ["read"] });
    expect(id).not.toBeNull();

    const principal = authenticateBearer(token);
    expect(principal).not.toBeNull();
    expect(principal!.kind).toBe("token");
    expect(principal!.scopes).toEqual(["read"]);

    expect(allowed(principal!.scopes, "GET")).toBe(true); // present scope allowed
    expect(allowed(principal!.scopes, "POST")).toBe(false); // missing scope denied
  });

  it("authenticates a review token: review implies read, both methods allowed", () => {
    const { token, hash } = generateApiToken();
    createApiToken({ name: "writer", tokenHash: hash, scopes: ["review"] });

    const principal = authenticateBearer(token);
    expect(principal!.scopes).toEqual(["read", "review"]);
    expect(allowed(principal!.scopes, "GET")).toBe(true);
    expect(allowed(principal!.scopes, "POST")).toBe(true);
  });

  it("fails closed on a corrupt stored scope set: every scope denied", () => {
    const { token, hash } = generateApiToken();
    createApiToken({ name: "corrupt", tokenHash: hash, scopes: ["nonsense"] });

    const principal = authenticateBearer(token);
    expect(principal!.scopes).toEqual([]);
    expect(allowed(principal!.scopes, "GET")).toBe(false);
    expect(allowed(principal!.scopes, "POST")).toBe(false);
  });

  it("returns null once the token is revoked", () => {
    const { token, hash } = generateApiToken();
    const id = createApiToken({ name: "to-revoke", tokenHash: hash, scopes: ["read"] })!;
    expect(authenticateBearer(token)).not.toBeNull();
    expect(revokeApiToken(id)).toBe(true);
    expect(authenticateBearer(token)).toBeNull();
  });
});
