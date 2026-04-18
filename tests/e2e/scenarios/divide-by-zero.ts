import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "divide-by-zero",
  description: "Bot should flag missing zero-check in divide() with a major-severity inline comment.",
  prTitle: "Add divide helper without zero guard",
  prBody: "Adds a `divide(a, b)` helper. Missing zero-check is intentional for the test.",
  files: [
    {
      path: "src/math.js",
      content: `function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, divide };
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 1 },
  expect: {
    reviewState: "CHANGES_REQUESTED",
    statusState: "failure",
    reviewBodyContains: [
      "**Actionable comments posted:",
      "ℹ️ Review info",
      "⚙️ Run configuration",
      "📥 Commits",
      "📒 Files selected for processing",
    ],
    walkthroughContains: [
      "📝 Walkthrough",
      "## Walkthrough",
      "## Changes",
      "🎯",
      "minutes",
      "walkthrough_start",
      "walkthrough_end",
    ],
    issueCommentContains: [
      "Comment `@diffsentry help`",
    ],
    inlineCommentsContain: [
      {
        pathContains: "math.js",
        bodyContains: [
          "_⚠️ Potential issue_",
          "🤖 Prompt for AI Agents",
          "diffsentry-fingerprint:",
          "auto-generated reply by DiffSentry",
        ],
      },
    ],
  },
};
