import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "dep-changes",
  description:
    "PR adds and bumps npm dependencies. Walkthrough should embed a 📦 Dependency Changes block with added/changed entries.",
  prTitle: "Add lodash, bump axios",
  prBody: "Adds lodash for collection helpers and bumps axios to the latest minor.",
  files: [
    {
      path: "package.json",
      content: `{
  "name": "sandbox-app",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "axios": "^1.7.0",
    "lodash": "^4.17.21",
    "react": "^18.3.1"
  }
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "📦 Dependency Changes",
      "lodash",
      "axios",
    ],
  },
};
