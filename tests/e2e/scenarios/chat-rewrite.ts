import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-rewrite",
  description:
    "@diffsentry rewrite should replace the PR title + description with the AI's proposal.",
  prTitle: "stuff",
  prBody: "k",
  files: [
    {
      path: "src/util/upper.ts",
      content: `export function upper(s: string): string {\n  return s.toUpperCase();\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry rewrite" },
  ],
  waitFor: { walkthrough: true, review: true, replyContains: ["AI-rewritten title"], timeoutMs: 240_000 },
  expect: { issueCommentContains: ["Actions performed", "AI-rewritten title"] },
};
