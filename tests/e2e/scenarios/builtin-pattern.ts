import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "builtin-pattern",
  description:
    "Diff contains a forEach(async ...) callback and a Math.random()-based token id. The built-in pattern engine should flag both.",
  prTitle: "Fan-out user fetch + token id helper",
  prBody: "Iterates user IDs to log them, plus a tiny token helper.",
  files: [
    {
      path: "src/users/hydrate.ts",
      content: `import fetch from "node-fetch";

export function hydrate(ids: string[]): void {
  ids.forEach(async (id) => {
    const u = await fetch(\`/api/users/\${id}\`).then((r) => r.json());
    console.log(u);
  });
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
      { pathContains: "hydrate.ts", bodyContains: ["async callback in .forEach"] },
      { pathContains: "hydrate.ts", bodyContains: ["Math.random()"] },
    ],
  },
};
