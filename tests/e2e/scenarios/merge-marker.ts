import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "merge-marker",
  description:
    "PR commits a file with stray merge conflict markers. Safety scanner should flag at least one as critical.",
  prTitle: "Resolve merge in config loader",
  prBody: "Resolves the merge conflict in the config loader.",
  files: [
    {
      path: "src/config/parse.ts",
      content: `export function parseConfig(input: string): Record<string, string> {
  const out: Record<string, string> = {};
<<<<<<< HEAD
  for (const line of input.split("\\n")) {
    const [k, v] = line.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
=======
  for (const line of input.split(/\\r?\\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
>>>>>>> feature/parse-rewrite
  return out;
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 1, timeoutMs: 240_000 },
  expect: {
    reviewState: "CHANGES_REQUESTED",
    inlineCommentsContain: [
      { pathContains: "parse.ts", bodyContains: ["merge conflict marker"] },
    ],
  },
};
