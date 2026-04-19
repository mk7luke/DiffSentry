import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-timeline",
  description:
    "@diffsentry timeline should reply with a chronological PR Timeline including the open event and at least one commit.",
  prTitle: "Add string trim helper",
  prBody: "Adds a small helper used by the upcoming form refactor.",
  files: [
    {
      path: "src/util/trim.ts",
      content: `export function squish(s: string): string {\n  return s.trim().replace(/\\s+/g, " ");\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry timeline" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    replyContains: ["🕒 PR Timeline"],
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "🕒 PR Timeline",
      "PR opened by",
      "Commit `",
    ],
  },
};
