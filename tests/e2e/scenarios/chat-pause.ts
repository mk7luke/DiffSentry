import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-pause",
  description:
    "@diffsentry pause should reply with a CodeRabbit-style [!NOTE] blockquote announcing the pause.",
  prTitle: "Trivial change for chat-pause test",
  prBody: "Used by the chat-pause e2e scenario.",
  files: [
    {
      path: "docs/chat-pause.md",
      content: `# Chat pause test\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry pause" },
  ],
  waitFor: {
    walkthrough: true,
    review: false,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 180_000,
  },
  expect: {
    issueCommentContains: [
      "[!NOTE]",
      "Reviews paused",
      "@diffsentry resume",
    ],
  },
};
