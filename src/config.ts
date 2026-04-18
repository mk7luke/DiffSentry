import fs from "fs";
import { Config } from "./types.js";

export function loadConfig(): Config {
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  let privateKey = process.env.GITHUB_PRIVATE_KEY || "";

  if (privateKeyPath && !privateKey) {
    privateKey = fs.readFileSync(privateKeyPath, "utf-8");
  }

  const aiProvider = (process.env.AI_PROVIDER || "anthropic") as Config["aiProvider"];

  if (aiProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  }
  if (aiProvider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
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
    aiProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o",
    maxFilesPerReview: parseInt(process.env.MAX_FILES_PER_REVIEW || "50", 10),
    ignoredPatterns: [...defaultIgnored, ...ignoredPatterns],
    botName: process.env.BOT_NAME || "diffsentry",
    learningsDir: process.env.LEARNINGS_DIR || "./data/learnings",
  };
}
