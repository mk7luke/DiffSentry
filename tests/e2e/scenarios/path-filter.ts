import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "path-filter",
  description:
    "PR touches generated/ + src/ with a .diffsentry.yaml excluding generated/* — review-info should list generated/* under 'Files ignored due to path filters'.",
  prTitle: "Add user model and regenerated client",
  prBody: "Adds a User model and regenerates the typed API client. The generated client should be excluded from review.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  path_filters:
    - "!generated/**"
`,
    },
    {
      path: "generated/api-client.ts",
      content: `// Auto-generated. Do not edit.\nexport class ApiClient {\n  async getUser(id: string) {\n    return fetch(\`/api/users/\${id}\`).then((r) => r.json());\n  }\n}\n`,
    },
    {
      path: "src/models/user.ts",
      content: `export interface User {\n  id: string;\n  email: string;\n  name: string;\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    reviewBodyContains: [
      "⛔ Files ignored due to path filters",
      "generated/api-client.ts",
      "📒 Files selected for processing",
      "src/models/user.ts",
    ],
  },
};
