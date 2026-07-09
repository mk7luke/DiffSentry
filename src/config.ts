import fs from "fs";
import { Config } from "./types.js";
import { DEFAULT_AI_REQUEST_TIMEOUT_MS } from "./ai/timeout.js";

// Canonical list of accepted AI providers. This is the single source of truth
// for the AI_PROVIDER enum — the runtime loader (below), the diagnostics check,
// and the interactive setup CLI all import it rather than re-hardcoding the
// strings, so a new provider is added in exactly one place and a typo like
// "claude" can never silently pass validation in one path while failing another.
export const AI_PROVIDERS = ["anthropic", "openai", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

// Canonical default model names. These literals live here only — other modules
// (e.g. the diagnostics config summary) import these rather than re-hardcoding.
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

export function loadConfig(): Config {
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  let privateKey = process.env.GITHUB_PRIVATE_KEY || "";

  if (privateKeyPath && !privateKey) {
    privateKey = fs.readFileSync(privateKeyPath, "utf-8");
  }

  const aiProvider = (process.env.AI_PROVIDER || "anthropic") as Config["aiProvider"];

  if (!isAiProvider(aiProvider)) {
    throw new Error(
      `AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")} (got: ${aiProvider})`
    );
  }
  if (aiProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  }
  if (aiProvider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }
  if (aiProvider === "openai-compatible" && !process.env.LOCAL_AI_BASE_URL) {
    throw new Error(
      "LOCAL_AI_BASE_URL is required when AI_PROVIDER=openai-compatible " +
        "(e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio)"
    );
  }
  if (aiProvider === "openai-compatible" && !process.env.LOCAL_AI_MODEL) {
    throw new Error(
      "LOCAL_AI_MODEL is required when AI_PROVIDER=openai-compatible " +
        "(the model name your local server exposes, e.g. 'llama3.1:70b' or 'qwen2.5-coder')"
    );
  }
  if (!process.env.GITHUB_APP_ID) {
    throw new Error("GITHUB_APP_ID is required");
  }
  if (!privateKey) {
    throw new Error("GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH is required");
  }
  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required");
  }
  // The dashboard signs its session + CSRF cookies with a dedicated secret.
  // It must be set explicitly when the dashboard is enabled: it previously fell
  // back to GITHUB_WEBHOOK_SECRET, which coupled two unrelated trust domains
  // (anyone able to forge a webhook signature could forge a dashboard session).
  // Fail fast at boot rather than silently reusing the webhook secret.
  if (process.env.ENABLE_DASHBOARD === "1" && !process.env.DASHBOARD_SESSION_SECRET) {
    throw new Error(
      "DASHBOARD_SESSION_SECRET is required when ENABLE_DASHBOARD=1 " +
        "(generate one with `openssl rand -hex 32`). It signs the dashboard " +
        "session and CSRF cookies and must be independent of GITHUB_WEBHOOK_SECRET."
    );
  }

  // AI request timeout (ms). A valid number is honored as-is — including <= 0,
  // which withAiTimeout treats as "no bound" (an explicit escape hatch). Only a
  // missing or non-numeric value falls back to the 60s default.
  const parsedTimeout = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "", 10);
  const aiRequestTimeoutMs = Number.isFinite(parsedTimeout)
    ? parsedTimeout
    : DEFAULT_AI_REQUEST_TIMEOUT_MS;

  // ─── Backup AI provider (failover) — off unless BACKUP_AI_PROVIDER is set ───
  const backupRaw = process.env.BACKUP_AI_PROVIDER;
  let backupAiProvider: Config["backupAiProvider"];
  let backupAnthropicApiKey: string | undefined;
  let backupAnthropicModel: string | undefined;
  let backupAnthropicBaseUrl: string | undefined;
  let backupOpenaiApiKey: string | undefined;
  let backupOpenaiModel: string | undefined;
  let backupOpenaiBaseUrl: string | undefined;
  let backupLocalAiBaseUrl: string | undefined;
  let backupLocalAiApiKey: string | undefined;
  let backupLocalAiModel: string | undefined;
  let backupLocalAiJsonMode: boolean | undefined;

  if (backupRaw) {
    if (!isAiProvider(backupRaw)) {
      throw new Error(
        `BACKUP_AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")} (got: ${backupRaw})`
      );
    }
    backupAiProvider = backupRaw;

    // Reuse-with-override: BACKUP_* wins, else fall back to the primary's env.
    backupAnthropicApiKey = process.env.BACKUP_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    backupAnthropicModel = process.env.BACKUP_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    backupAnthropicBaseUrl = process.env.BACKUP_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    backupOpenaiApiKey = process.env.BACKUP_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    backupOpenaiModel = process.env.BACKUP_OPENAI_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    backupOpenaiBaseUrl = process.env.BACKUP_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
    backupLocalAiBaseUrl = process.env.BACKUP_LOCAL_AI_BASE_URL || process.env.LOCAL_AI_BASE_URL;
    backupLocalAiApiKey = process.env.BACKUP_LOCAL_AI_API_KEY || process.env.LOCAL_AI_API_KEY;
    backupLocalAiModel = process.env.BACKUP_LOCAL_AI_MODEL || process.env.LOCAL_AI_MODEL || "";
    backupLocalAiJsonMode =
      (process.env.BACKUP_LOCAL_AI_JSON_MODE || process.env.LOCAL_AI_JSON_MODE || "true").toLowerCase() !== "false";

    // Fail fast if the resolved backup can't actually be constructed.
    if (backupAiProvider === "anthropic" && !backupAnthropicApiKey) {
      throw new Error("BACKUP_AI_PROVIDER=anthropic requires BACKUP_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY");
    }
    if (backupAiProvider === "openai" && !backupOpenaiApiKey) {
      throw new Error("BACKUP_AI_PROVIDER=openai requires BACKUP_OPENAI_API_KEY or OPENAI_API_KEY");
    }
    if (backupAiProvider === "openai-compatible" && (!backupLocalAiBaseUrl || !backupLocalAiModel)) {
      throw new Error(
        "BACKUP_AI_PROVIDER=openai-compatible requires BACKUP_LOCAL_AI_BASE_URL and BACKUP_LOCAL_AI_MODEL " +
          "(or the primary LOCAL_AI_BASE_URL / LOCAL_AI_MODEL to reuse)"
      );
    }
  }

  // Short primary deadline (only meaningful when a backup is configured). Clamp
  // to at most the normal bound so the primary is never given LONGER than the
  // overall per-op budget.
  // A non-positive value would disable the primary's bound (withAiTimeout treats
  // timeoutMs <= 0 as "no deadline"), so a mis-set 0/negative would leave the
  // primary un-bounded and defeat fast failover. Reject it and fall back to the
  // 20s default, mirroring the breaker-knob guards below.
  const parsedPrimaryTimeout = parseInt(process.env.PRIMARY_AI_TIMEOUT_MS || "", 10);
  let primaryAiTimeoutMs =
    Number.isFinite(parsedPrimaryTimeout) && parsedPrimaryTimeout > 0 ? parsedPrimaryTimeout : 20_000;
  if (aiRequestTimeoutMs > 0 && primaryAiTimeoutMs > aiRequestTimeoutMs) {
    primaryAiTimeoutMs = aiRequestTimeoutMs;
  }

  const parsedThreshold = parseInt(process.env.BACKUP_CIRCUIT_THRESHOLD || "", 10);
  const backupCircuitThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 1 ? parsedThreshold : 3;

  const parsedCooldown = parseInt(process.env.BACKUP_CIRCUIT_COOLDOWN_MS || "", 10);
  const backupCircuitCooldownMs = Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : 60_000;

  const ignoredPatterns = (process.env.IGNORED_PATTERNS || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const defaultIgnored = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.min.js",
    "*.min.css",
    "*.map",
    "dist/**",
    "build/**",
    ".next/**",
  ];

  return {
    port: parseInt(process.env.PORT || "3005", 10),
    githubAppId: process.env.GITHUB_APP_ID,
    githubPrivateKey: privateKey,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    dashboardSessionSecret: process.env.DASHBOARD_SESSION_SECRET,
    aiProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    anthropicModel: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    openaiModel: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    localAiBaseUrl: process.env.LOCAL_AI_BASE_URL,
    localAiApiKey: process.env.LOCAL_AI_API_KEY,
    localAiModel: process.env.LOCAL_AI_MODEL || "",
    localAiJsonMode: (process.env.LOCAL_AI_JSON_MODE || "true").toLowerCase() !== "false",
    aiRequestTimeoutMs,
    backupAiProvider,
    backupAnthropicApiKey,
    backupAnthropicModel,
    backupAnthropicBaseUrl,
    backupOpenaiApiKey,
    backupOpenaiModel,
    backupOpenaiBaseUrl,
    backupLocalAiBaseUrl,
    backupLocalAiApiKey,
    backupLocalAiModel,
    backupLocalAiJsonMode,
    primaryAiTimeoutMs,
    backupCircuitThreshold,
    backupCircuitCooldownMs,
    maxFilesPerReview: parseInt(process.env.MAX_FILES_PER_REVIEW || "50", 10),
    ignoredPatterns: [...defaultIgnored, ...ignoredPatterns],
    botName: process.env.BOT_NAME || "diffsentry",
    learningsDir: process.env.LEARNINGS_DIR || "./data/learnings",
  };
}
