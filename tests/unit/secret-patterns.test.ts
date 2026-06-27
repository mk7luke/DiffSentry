import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS } from "../../src/secret-patterns.js";

// SECRET_PATTERNS is the authoritative secret-shape list shared by the diff
// safety scanner (src/safety-scanner.ts) and the log-tail redactor
// (src/logger.ts). Per the repo's path_instructions for the scanner, every
// pattern carries a real-world example that MUST match and a plausible example
// that MUST NOT — so a regex edit that widens (false positives) or narrows
// (missed leaks) the list is caught here, independent of either caller.
//
// The fixtures below are synthetic / documentation placeholders, not real keys.

interface PatternCase {
  match: string; // a string the pattern must flag
  nonMatch: string; // a plausible string the pattern must NOT flag
}

const CASES: Record<string, PatternCase> = {
  "aws-access-key-id": {
    match: "AKIA" + "IOSFODNN7EXAMPLE",
    nonMatch: "AKIA is the AWS key prefix", // prefix word, not a 20-char key
  },
  "aws-secret-access-key": {
    match: `aws_secret_access_key = "${"a".repeat(40)}"`,
    nonMatch: "aws_secret_access_key = process.env.AWS_SECRET", // env lookup, no literal
  },
  "github-token": {
    match: "ghp_" + "A".repeat(36),
    nonMatch: "ghp_short", // too short to be a token
  },
  "anthropic-key": {
    match: "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0",
    nonMatch: "sk-ant-x", // too short
  },
  "openai-key": {
    match: "sk-" + "a1B2c3D4e5F6g7H8i9J0",
    nonMatch: "ask-the-user-first", // 'sk-' only inside a word, no boundary
  },
  "slack-token": {
    match: "xoxb-123456789012-abcdefABCDEF",
    nonMatch: "xoxb-short", // below the length floor
  },
  "stripe-key": {
    match: "sk_live_" + "a1B2c3D4e5F6g7H8i9J0",
    nonMatch: "sk_live_short", // below the length floor
  },
  "google-api-key": {
    match: "AIza" + "a".repeat(35),
    nonMatch: "AIzaTooShortToBeAGoogleKey", // not 35 trailing chars
  },
  "private-key-pem": {
    match: "-----BEGIN RSA PRIVATE KEY-----",
    nonMatch: "-----BEGIN CERTIFICATE-----", // public cert, not a private key
  },
  jwt: {
    match: "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM",
    nonMatch: "eyJustAWord without dots", // missing the dotted segments
  },
  "generic-bearer": {
    match: "Bearer abcdefghijklmnopqrstuvwxyz0123",
    nonMatch: "Bearer xyz", // token too short
  },
};

describe("SECRET_PATTERNS", () => {
  it("every pattern in the module has a match/non-match fixture here", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual(Object.keys(CASES).sort());
  });

  it("has unique pattern ids", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const { id, regex } of SECRET_PATTERNS) {
    describe(id, () => {
      const c = CASES[id];
      it("matches a real-world example", () => {
        // Fresh regex per assertion so a stray /g flag can't carry lastIndex.
        expect(new RegExp(regex.source, regex.flags).test(c.match)).toBe(true);
      });
      it("does not match a plausible non-secret", () => {
        expect(new RegExp(regex.source, regex.flags).test(c.nonMatch)).toBe(false);
      });
    });
  }
});
