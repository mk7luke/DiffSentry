import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "license-header",
  description:
    "Repo requires an Apache-2.0 license header on src/**/*. PR adds two new files; one has the header, one doesn't. Walkthrough should flag the missing one.",
  prTitle: "Add formatter and parser modules",
  prBody: "Adds two helpers under src/formatter and src/parser.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  license_header:
    required: |
      // Copyright 2026 Acme. Apache-2.0 license.
    paths:
      - "src/**/*.ts"
`,
    },
    {
      path: "src/formatter/index.ts",
      content: `// Copyright 2026 Acme. Apache-2.0 license.\n\nexport function fmt(x: unknown): string {\n  return JSON.stringify(x, null, 2);\n}\n`,
    },
    {
      path: "src/parser/index.ts",
      content: `export function parseJson<T>(s: string): T {\n  return JSON.parse(s) as T;\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "📜 Missing License Headers",
      "src/parser/index.ts",
    ],
  },
};
