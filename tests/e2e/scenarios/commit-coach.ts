import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "commit-coach",
  description:
    "PR opens with a follow-up commit with a weak message ('wip'). Walkthrough should embed a ✍️ Commit Message Coach block flagging it.",
  prTitle: "Commit-coach test",
  prBody: "Smoke test for the commit-message coach.",
  files: [
    {
      path: "src/util/noop.ts",
      content: `export function noop(): void {}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 5_000 },
    {
      type: "push",
      commitMessage: "wip",
      files: [
        {
          path: "src/util/noop2.ts",
          content: `export function noop2(): void {}\n`,
        },
      ],
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 360_000 },
  expect: {
    walkthroughContains: [
      "✍️ Commit Message Coach",
      "wip",
    ],
  },
};
