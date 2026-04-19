import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "title-coach",
  description:
    "PR with a vague past-tense title. Walkthrough should embed a 🏷️ PR Title Coach block flagging it.",
  prTitle: "Updated stuff.",
  prBody:
    "Bumps the read timeout on the user lookup so we stop seeing flake under load. Touches a single helper.",
  files: [
    {
      path: "src/users/lookup.ts",
      content: `const READ_TIMEOUT_MS = 5_000;\n\nexport async function fetchUser(id: string): Promise<unknown> {\n  const ctrl = new AbortController();\n  const t = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);\n  try {\n    const res = await fetch(\`/api/users/\${id}\`, { signal: ctrl.signal });\n    return res.json();\n  } finally {\n    clearTimeout(t);\n  }\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "🏷️ PR Title Coach",
      "Updated stuff",
    ],
  },
};
