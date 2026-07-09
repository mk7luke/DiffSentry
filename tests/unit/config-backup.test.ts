import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

// loadConfig requires the core GitHub vars; set a minimal valid baseline and
// vary only the AI/backup vars per test. We snapshot + restore process.env.
const BASE: Record<string, string> = {
  GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  AI_PROVIDER: "openai-compatible",
  LOCAL_AI_BASE_URL: "http://localhost:1234/v1",
  LOCAL_AI_MODEL: "grok-4.5",
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
  // Fresh env containing only what each test sets (plus BASE).
  process.env = { ...BASE } as NodeJS.ProcessEnv;
});
afterEach(() => {
  process.env = saved;
});

describe("backup provider config", () => {
  it("is off by default (no BACKUP_AI_PROVIDER)", () => {
    const cfg = loadConfig();
    expect(cfg.backupAiProvider).toBeUndefined();
  });

  it("reuses primary env when only BACKUP_AI_PROVIDER is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-reused";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    const cfg = loadConfig();
    expect(cfg.backupAiProvider).toBe("anthropic");
    expect(cfg.backupAnthropicApiKey).toBe("sk-ant-reused");
  });

  it("prefers BACKUP_* overrides over primary env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-primary";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    process.env.BACKUP_ANTHROPIC_API_KEY = "sk-ant-backup";
    process.env.BACKUP_ANTHROPIC_MODEL = "claude-opus-4-8";
    const cfg = loadConfig();
    expect(cfg.backupAnthropicApiKey).toBe("sk-ant-backup");
    expect(cfg.backupAnthropicModel).toBe("claude-opus-4-8");
  });

  it("throws when the backup credential is missing", () => {
    process.env.BACKUP_AI_PROVIDER = "anthropic"; // no ANTHROPIC key anywhere
    expect(() => loadConfig()).toThrow(/BACKUP_AI_PROVIDER=anthropic/);
  });

  it("rejects an unknown BACKUP_AI_PROVIDER", () => {
    process.env.BACKUP_AI_PROVIDER = "claude";
    expect(() => loadConfig()).toThrow(/BACKUP_AI_PROVIDER/);
  });

  it("defaults the short primary timeout and breaker knobs", () => {
    process.env.ANTHROPIC_API_KEY = "sk";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    const cfg = loadConfig();
    expect(cfg.primaryAiTimeoutMs).toBe(20_000);
    expect(cfg.backupCircuitThreshold).toBe(3);
    expect(cfg.backupCircuitCooldownMs).toBe(60_000);
  });

  it("clamps the primary timeout to at most AI_REQUEST_TIMEOUT_MS", () => {
    process.env.ANTHROPIC_API_KEY = "sk";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    process.env.AI_REQUEST_TIMEOUT_MS = "15000";
    process.env.PRIMARY_AI_TIMEOUT_MS = "20000";
    const cfg = loadConfig();
    expect(cfg.primaryAiTimeoutMs).toBe(15_000);
  });
});
