import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isValidGitHubAppId, loadConfig } from "../../src/config.js";
import { validateEnvContent } from "../../scripts/setup.js";

const BASE: Record<string, string> = {
  GITHUB_APP_ID: "4747134",
  GITHUB_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  AI_PROVIDER: "openai-compatible",
  LOCAL_AI_BASE_URL: "http://localhost:1234/v1",
  LOCAL_AI_MODEL: "grok-4.5",
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
  process.env = { ...BASE } as NodeJS.ProcessEnv;
});
afterEach(() => {
  process.env = saved;
});

describe("GITHUB_APP_ID validation", () => {
  it("accepts a numeric App ID", () => {
    const cfg = loadConfig();
    expect(cfg.githubAppId).toBe("4747134");
  });

  it("trims surrounding whitespace so the JWT iss claim stays an integer", () => {
    process.env.GITHUB_APP_ID = "  4747134  ";
    expect(loadConfig().githubAppId).toBe("4747134");
  });

  it("rejects a Client ID masquerading as the App ID", () => {
    process.env.GITHUB_APP_ID = "Iv23liN5SOYtQEENAOkQ";
    expect(() => loadConfig()).toThrow(/must be numeric/);
  });

  it("rejects a stray non-digit prefix that would fail GitHub's iss claim", () => {
    process.env.GITHUB_APP_ID = "y4747134";
    expect(() => loadConfig()).toThrow(/must be numeric/);
  });

  it("still requires the variable to be set", () => {
    delete process.env.GITHUB_APP_ID;
    expect(() => loadConfig()).toThrow(/GITHUB_APP_ID is required/);
  });

  it("exports isValidGitHubAppId predicate", () => {
    expect(isValidGitHubAppId("123456")).toBe(true);
    expect(isValidGitHubAppId("  123456  ")).toBe(true);
    expect(isValidGitHubAppId("Iv23liN5SOYtQEENAOkQ")).toBe(false);
    expect(isValidGitHubAppId("")).toBe(false);
    expect(isValidGitHubAppId("abc123")).toBe(false);
  });

  it("validates GITHUB_APP_ID format in setup validateEnvContent", () => {
    const validEnv = [
      "GITHUB_APP_ID=123456",
      "GITHUB_PRIVATE_KEY_PATH=./key.pem",
      "GITHUB_WEBHOOK_SECRET=secret",
      "AI_PROVIDER=anthropic",
      "ANTHROPIC_API_KEY=sk-ant-test",
    ].join("\n");
    expect(validateEnvContent(validEnv)).toEqual([]);

    const invalidEnv = [
      "GITHUB_APP_ID=Iv23liN5SOYtQEENAOkQ",
      "GITHUB_PRIVATE_KEY_PATH=./key.pem",
      "GITHUB_WEBHOOK_SECRET=secret",
      "AI_PROVIDER=anthropic",
      "ANTHROPIC_API_KEY=sk-ant-test",
    ].join("\n");
    expect(validateEnvContent(invalidEnv)).toContainEqual(
      expect.stringContaining("GITHUB_APP_ID must be numeric")
    );
  });
});
