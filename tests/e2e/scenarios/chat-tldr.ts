import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-tldr",
  description:
    "@diffsentry tldr should reply with a single-paragraph TL;DR (no headings or bullet lists).",
  prTitle: "Add caching layer to user lookup",
  prBody: "Wraps the user lookup in a 30-second LRU cache to absorb hot-path bursts.",
  files: [
    {
      path: "src/users/cache.ts",
      content: `const CACHE = new Map<string, { value: any; expiresAt: number }>();
const TTL_MS = 30_000;

export function getCached<T>(key: string): T | null {
  const entry = CACHE.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    CACHE.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCached(key: string, value: unknown): void {
  CACHE.set(key, { value, expiresAt: Date.now() + TTL_MS });
}
`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry tldr" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "## TL;DR",
      "cache",
    ],
  },
};
