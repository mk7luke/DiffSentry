import crypto from "node:crypto";
import type { TokenPrincipal } from "../dashboard/roles.js";
import { findActiveApiTokenByHash, touchApiTokenLastUsed } from "../storage/dao.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// API token auth — the platform side of DiffSentry.
//
// A token is a high-entropy, prefixed, URL-safe string shown to its creator
// exactly once. Only its SHA-256 hash is persisted; authentication hashes the
// presented bearer and looks the row up by that hash (indexed), rejecting
// revoked tokens. The token carries scopes that the API gate enforces:
//
//   read    → every GET read endpoint (repos, findings, patterns, health, …)
//   review  → the safe action subset (trigger review, resolve, pause/resume/cancel)
//
// Tokens never reach admin endpoints (audit, role/token administration): those
// require a cookie session and a real admin login. See resolveActor / the gate.
// ─────────────────────────────────────────────────────────────────────────────

export const API_SCOPES = ["read", "review"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
const SCOPE_SET = new Set<string>(API_SCOPES);

/** Token prefix — recognizable + greppable in logs/configs (it is NOT secret). */
export const TOKEN_PREFIX = "dsk_";

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && SCOPE_SET.has(v);
}

/**
 * Normalize + validate a requested scope list: dedupe, drop unknowns, and keep
 * the canonical order. An empty/garbage request defaults to `['read']` so a
 * token is never minted useless. `review` implies `read` (a writer can read).
 */
export function normalizeScopes(input: unknown): ApiScope[] {
  const arr = Array.isArray(input) ? input : [];
  const out = new Set<ApiScope>();
  for (const s of arr) if (isApiScope(s)) out.add(s);
  if (out.size === 0) out.add("read");
  if (out.has("review")) out.add("read");
  return API_SCOPES.filter((s) => out.has(s));
}

/** The scope a request requires, by HTTP method: reads need `read`, writes need
 *  `review`. Used by the gate to reject an over-/under-scoped token. */
export function requiredScopeForMethod(method: string): ApiScope {
  return method === "GET" || method === "HEAD" ? "read" : "review";
}

/** SHA-256 hex of the token string — what we persist and look up by. */
export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Mint a new token: a prefixed, 240-bit, URL-safe string and its hash. */
export function generateApiToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(30).toString("base64url");
  return { token, hash: hashApiToken(token) };
}

/** Pull the bearer credential out of an `Authorization` header value. Returns
 *  null when the header is absent or not a Bearer scheme. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate a bearer token. On success returns a TokenPrincipal and bumps
 * the row's last_used_at; returns null when the token is malformed, unknown,
 * revoked, or persistence is disabled.
 *
 * The lookup is a single indexed hash match. The token itself is 240 bits of
 * entropy, so there is no useful timing oracle against the hash comparison —
 * an attacker cannot incrementally guess a SHA-256 preimage.
 */
export function authenticateBearer(authorizationHeader: string | undefined): TokenPrincipal | null {
  const token = extractBearer(authorizationHeader);
  if (!token) return null;
  const row = findActiveApiTokenByHash(hashApiToken(token));
  if (!row) return null;

  let scopes: string[] = [];
  if (row.scopes_json) {
    try {
      const parsed = JSON.parse(row.scopes_json);
      if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
    } catch (err) {
      logger.debug({ err, tokenId: row.id }, "token-auth: malformed scopes_json — treating as no scopes");
    }
  }

  touchApiTokenLastUsed(row.id);
  return { kind: "token", tokenId: row.id, name: row.name, scopes };
}
