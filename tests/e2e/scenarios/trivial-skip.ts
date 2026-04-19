import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "trivial-skip",
  description:
    "PR contains a substantive file + a comment-only/whitespace-only file. The trivial file should appear in '✅ Files skipped from review due to trivial changes' and not get an inline review.",
  prTitle: "Add config helper, tweak header comment",
  prBody: "Adds a real config helper and updates a header comment in another file (no semantic change).",
  files: [
    {
      path: "src/config/load.ts",
      content: `import fs from "node:fs";\n\nexport function loadConfig(path: string): Record<string, unknown> {\n  return JSON.parse(fs.readFileSync(path, "utf8"));\n}\n`,
    },
    {
      path: "src/header-only.ts",
      content: `// Updated: header comment was tweaked, no logic change.\n// This module currently exports nothing.\nexport {};\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    reviewBodyContains: [
      "✅ Files skipped from review due to trivial changes",
      "src/header-only.ts",
    ],
  },
};
