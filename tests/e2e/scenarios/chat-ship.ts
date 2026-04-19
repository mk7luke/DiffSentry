import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-ship",
  description:
    "@diffsentry ship should reply with a Ship Check verdict block listing surfaces and any blockers.",
  prTitle: "Add token utility",
  prBody: "Adds a small token-id helper for the upcoming auth changes.",
  files: [
    {
      path: "src/util/token.ts",
      content: `import crypto from "node:crypto";\n\nexport function tokenId(): string {\n  return crypto.randomBytes(8).toString("hex");\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry ship" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "🚀 Ship Check",
      "DiffSentry review",
    ],
  },
};
