import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "sticky-status",
  description:
    "After review, the bot should upsert a sticky status comment containing the verdict + risk + threads/checks table.",
  prTitle: "Add tiny config helper",
  prBody: "Adds a single getter so the rest of the app can read settings.",
  files: [
    {
      path: "src/util/setting.ts",
      content: `export function getSetting(name: string, fallback: string): string {\n  return process.env[name] ?? fallback;\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, botIssueCommentsAtLeast: 3, timeoutMs: 240_000 },
  expect: {
    issueCommentContains: [
      "DiffSentry Sticky Status",
      "📌 Status",
      "Risk score",
    ],
  },
};
