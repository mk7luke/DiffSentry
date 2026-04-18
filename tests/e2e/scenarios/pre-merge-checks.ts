import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "pre-merge-checks",
  description:
    "PR with bad title + missing description + .diffsentry.yaml pre-merge config — walkthrough should embed a pre-merge checks <details> sibling block.",
  prTitle: "wip",
  prBody: "x",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  pre_merge_checks:
    title:
      mode: "warning"
      requirements: "Must start with an imperative verb and be at least 10 characters."
    description:
      mode: "warning"
      requirements: "Must explain WHAT changed and WHY in at least one full sentence."
`,
    },
    {
      path: "src/util/noop.ts",
      content: `export function noop(): void {}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "🚥 Pre-merge checks",
      "Failed checks",
      "Check name",
    ],
  },
};
