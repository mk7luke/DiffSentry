import { describe, it, expect } from "vitest";
import { validateEnvContent } from "../../scripts/setup.js";

const base = (appId: string) =>
  [
    `GITHUB_APP_ID=${appId}`,
    "GITHUB_PRIVATE_KEY_PATH=./private-key.pem",
    "GITHUB_WEBHOOK_SECRET=secret",
    "AI_PROVIDER=anthropic",
    "ANTHROPIC_API_KEY=sk-ant-test",
    "",
  ].join("\n");

describe("setup .env validator — GITHUB_APP_ID", () => {
  it("accepts a numeric App ID", () => {
    expect(validateEnvContent(base("4747134"))).toEqual([]);
  });

  it("flags a Client ID written in place of the App ID", () => {
    const problems = validateEnvContent(base("Iv23liN5SOYtQEENAOkQ"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/GITHUB_APP_ID must be numeric/);
  });

  it("flags an app slug written in place of the App ID", () => {
    expect(validateEnvContent(base("diffsentry")).join()).toMatch(/must be numeric/);
  });

  it("reports the empty value once, not twice", () => {
    const problems = validateEnvContent(base(""));
    expect(problems).toEqual(["GITHUB_APP_ID is required but empty"]);
  });

  it("accepts a quoted numeric App ID", () => {
    expect(validateEnvContent(base('"4747134"'))).toEqual([]);
  });
});
