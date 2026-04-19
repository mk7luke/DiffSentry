import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "incremental-review",
  description:
    "Open PR, wait for first review, push a second commit. The walkthrough should embed the internal-state blob and the second review's commits line should reference 'Reviewing files that changed from <prev> to <new>'.",
  prTitle: "Incremental review test",
  prBody: "First commit adds a helper. Second commit adds a callsite — the bot should only re-review what changed.",
  files: [
    {
      path: "src/util/sum.ts",
      content: `export function sum(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n`,
    },
  ],
  postPrActions: [
    // Wait for the first review to land + state blob to be embedded
    { type: "wait", ms: 60_000 },
    {
      type: "push",
      commitMessage: "Add caller for sum()",
      files: [
        {
          path: "src/cli/total.ts",
          content: `import { sum } from "../util/sum.js";\n\nconst args = process.argv.slice(2).map(Number);\nconsole.log("total:", sum(args));\n`,
        },
      ],
    },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 360_000,
  },
  expect: {
    walkthroughContains: [
      "internal_state_start",
      "diffsentry-state:",
    ],
    reviewBodyContains: [
      "Reviewing files that changed from",
    ],
  },
};
