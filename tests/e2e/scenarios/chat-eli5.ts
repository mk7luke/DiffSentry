import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-eli5",
  description:
    "@diffsentry eli5 should reply with a plain-English explanation organized into sections (no code blocks).",
  prTitle: "Switch session storage to Redis",
  prBody:
    "Moves session storage from the in-process Map to Redis with a 24-hour TTL. Falls back to in-memory if Redis is unreachable.",
  files: [
    {
      path: "src/session/redis-store.ts",
      content: `import { createClient, RedisClientType } from "redis";\n\nconst TTL_SECONDS = 24 * 60 * 60;\nlet client: RedisClientType | null = null;\n\nasync function getClient(): Promise<RedisClientType> {\n  if (client?.isReady) return client;\n  client = createClient({ url: process.env.REDIS_URL });\n  await client.connect();\n  return client;\n}\n\nexport async function putSession(id: string, payload: unknown): Promise<void> {\n  const c = await getClient();\n  await c.set(\`sess:\${id}\`, JSON.stringify(payload), { EX: TTL_SECONDS });\n}\n\nexport async function getSession<T>(id: string): Promise<T | null> {\n  const c = await getClient();\n  const raw = await c.get(\`sess:\${id}\`);\n  return raw ? (JSON.parse(raw) as T) : null;\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry eli5" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    replyContains: ["🧒 ELI5"],
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "🧒 ELI5",
      "What this PR is about",
    ],
  },
};
