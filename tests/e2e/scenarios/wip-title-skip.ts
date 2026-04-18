import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "wip-title-skip",
  description:
    "PR with WIP-style title and a .diffsentry.yaml that ignores WIP titles should produce no bot review.",
  prTitle: "WIP: do not review me",
  prBody: "This PR exists to verify the auto-review skip behavior for WIP titles.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  auto_review:
    enabled: true
    ignore_title_keywords:
      - "WIP"
`,
    },
    {
      path: "notes/wip.md",
      content: `# WIP\n\nIn progress, do not review.\n`,
    },
  ],
  waitFor: {
    walkthrough: false,
    review: false,
    timeoutMs: 90_000,
  },
  expect: {
    noBotActivity: true,
  },
};
