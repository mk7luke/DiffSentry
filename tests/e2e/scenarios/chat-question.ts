import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-question",
  description:
    "Free-form @diffsentry question — should reply with a chat answer (no Actions performed wrapper).",
  prTitle: "Add timeout helper",
  prBody: "Adds a setTimeout-based promise helper.",
  files: [
    {
      path: "src/util/timeout.ts",
      content: `export function delay(ms: number): Promise<void> {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry what does the new delay function do, and is it safe to use in a hot loop?" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    replyContains: ["delay"],
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: ["delay"],
  },
};
