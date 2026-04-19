import type { Scenario } from "../types.js";

// We compare against PR #1 in the sandbox repo (the long-closed smoke test).
// The smoke-test PR touched `hello.js`; this PR touches `src/util/foo.ts`,
// so we expect zero overlap.
export const scenario: Scenario = {
  name: "chat-diff-pr",
  description: "@diffsentry diff <PR-number> should reply with a 🔀 Diff comparison.",
  prTitle: "Add foo helper",
  prBody: "Adds a tiny foo helper used by the upcoming refactor.",
  files: [
    {
      path: "src/util/foo.ts",
      content: `export function foo(): string {\n  return "foo";\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry diff 1" },
  ],
  waitFor: { walkthrough: true, review: true, botIssueCommentsAtLeast: 4, timeoutMs: 240_000 },
  expect: { issueCommentContains: ["🔀 Diff vs"] },
};
