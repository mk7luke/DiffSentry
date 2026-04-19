import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "poem-walkthrough",
  description:
    "PR with .diffsentry.yaml enabling the poem — walkthrough should include a ## Poem section.",
  prTitle: "Add greeting helper",
  prBody: "Adds a tiny greeting helper used in the new welcome flow.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  walkthrough:
    enabled: true
    collapse: true
    poem: true
`,
    },
    {
      path: "src/util/greeting.ts",
      content: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "## Poem",
    ],
  },
};
