import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-help",
  description: "After initial review, `@diffsentry help` should produce a help message listing commands.",
  prTitle: "Trivial change for chat-help test",
  prBody: "Used by the chat-help e2e scenario.",
  files: [
    {
      path: "docs/chat-help.md",
      content: `# Chat help test\n\nNothing to see here.\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry help" },
  ],
  waitFor: {
    walkthrough: true,
    review: false,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 180_000,
  },
  expect: {
    issueCommentContains: ["review", "pause"],
  },
};
