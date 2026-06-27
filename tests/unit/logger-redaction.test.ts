import { describe, expect, it } from "vitest";
import { redactSecrets, logger, getRecentLogs } from "../../src/logger.js";

// The dashboard surfaces the recent warn/error log ring buffer, so any secret
// that lands in a log line must be scrubbed before it is retained. redactSecrets
// reuses the diff safety-scanner's secret shapes (src/secret-patterns.ts) so
// detection stays consistent across both surfaces.

describe("redactSecrets", () => {
  const cases: Array<{ name: string; secret: string; id: string }> = [
    { name: "GitHub token", secret: "ghp_" + "A".repeat(36), id: "github-token" },
    { name: "GitHub fine-grained token", secret: "ghs_" + "b1C2".repeat(10), id: "github-token" },
    { name: "AWS access key id", secret: "AKIAIOSFODNN7EXAMPLE", id: "aws-access-key-id" },
    { name: "OpenAI key", secret: "sk-" + "a1B2c3D4e5F6g7H8i9J0", id: "openai-key" },
    { name: "OpenAI project key", secret: "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0", id: "openai-key" },
    { name: "Anthropic key", secret: "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0", id: "anthropic-key" },
    { name: "Slack token", secret: "xoxb-123456789012-abcdefABCDEF", id: "slack-token" },
    { name: "bearer token", secret: "Bearer abcdefghijklmnopqrstuvwxyz0123", id: "generic-bearer" },
  ];

  for (const { name, secret, id } of cases) {
    it(`redacts a ${name}`, () => {
      const out = redactSecrets(`auth failed using ${secret} while connecting`);
      expect(out).not.toContain(secret);
      expect(out).toContain(`[REDACTED:${id}]`);
    });
  }

  it("redacts a PEM private-key header", () => {
    const out = redactSecrets("loaded key: -----BEGIN RSA PRIVATE KEY----- MIIE...");
    expect(out).toContain("[REDACTED:private-key-pem]");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redacts multiple secrets in a single line", () => {
    const gh = "ghp_" + "Z".repeat(36);
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const out = redactSecrets(`token=${gh} key=${aws}`);
    expect(out).not.toContain(gh);
    expect(out).not.toContain(aws);
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).toContain("[REDACTED:aws-access-key-id]");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Notification engine started (bus subscriber + hourly digest tick)";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("log ring buffer redaction", () => {
  it("scrubs secrets from both msg and raw before they reach getRecentLogs", () => {
    const token = "ghp_" + "Q".repeat(36);
    // The ring stream only retains warn+ levels (see logger.ts multistream).
    logger.warn({ webhookUrl: `https://hooks.example.com/${token}` }, `delivery failed for ${token}`);
    const recent = getRecentLogs();
    const entry = recent.find((e) => e.msg.includes("delivery failed for"));
    expect(entry).toBeDefined();
    expect(entry!.msg).not.toContain(token);
    expect(entry!.msg).toContain("[REDACTED:github-token]");
    // raw is the full serialized line — the token also appears in the bound
    // `webhookUrl` field there, and must be scrubbed too.
    expect(entry!.raw).not.toContain(token);
    expect(entry!.raw).toContain("[REDACTED:github-token]");
  });
});
