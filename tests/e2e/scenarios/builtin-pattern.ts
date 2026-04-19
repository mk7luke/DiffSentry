import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "builtin-pattern",
  description:
    "Diff contains sequential await in a for-of loop and a Math.random()-based id. The built-in pattern engine should flag both.",
  prTitle: "Fan-out user fetch + token id helper",
  prBody: "Loops over user IDs to hydrate them, plus a tiny token helper.",
  files: [
    {
      path: "src/users/hydrate.ts",
      content: `import fetch from "node-fetch";

export async function hydrate(ids: string[]) {
  const out = [];
  for (const id of ids) {
    const u = await fetch(\`/api/users/\${id}\`).then((r) => r.json());
    out.push(u);
  }
  return out;
}

export function tokenId(): string {
  return Math.floor(Math.random() * 1e16).toString(36);
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 2, timeoutMs: 240_000 },
  expect: {
    inlineCommentsContain: [
      { pathContains: "hydrate.ts", bodyContains: ["Sequential await"] },
      { pathContains: "hydrate.ts", bodyContains: ["Math.random()"] },
    ],
  },
};
