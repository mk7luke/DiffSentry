import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-bench",
  description: "@diffsentry bench should reply with a 🧪 Bench section.",
  prTitle: "Add Levenshtein distance helper",
  prBody: "Adds a classic Levenshtein implementation for fuzzy matching.",
  files: [
    {
      path: "src/util/levenshtein.ts",
      content: `export function distance(a: string, b: string): number {\n  if (a === b) return 0;\n  if (!a.length) return b.length;\n  if (!b.length) return a.length;\n  const prev = Array(b.length + 1).fill(0).map((_, i) => i);\n  for (let i = 1; i <= a.length; i++) {\n    let cur = i;\n    let nw = prev[0];\n    prev[0] = i;\n    for (let j = 1; j <= b.length; j++) {\n      const ne = prev[j];\n      cur = a[i - 1] === b[j - 1] ? nw : Math.min(nw, prev[j - 1], ne) + 1;\n      nw = ne;\n      prev[j] = cur;\n    }\n  }\n  return prev[b.length];\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry bench" },
  ],
  waitFor: { walkthrough: true, review: true, replyContains: ["🧪 Bench"], timeoutMs: 240_000 },
  expect: { issueCommentContains: ["🧪 Bench"] },
};
