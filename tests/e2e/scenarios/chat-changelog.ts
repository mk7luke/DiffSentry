import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-changelog",
  description: "@diffsentry changelog should reply with a Keep-a-Changelog entry.",
  prTitle: "Add session expiry sweep",
  prBody: "Drops sessions older than 24h on every read.",
  files: [
    {
      path: "src/session/sweep.ts",
      content: `const TTL_MS = 24 * 60 * 60 * 1000;\nconst sessions = new Map<string, { issuedAt: number }>();\nexport function sweep(): number {\n  const cut = Date.now() - TTL_MS;\n  let dropped = 0;\n  for (const [k, v] of sessions) {\n    if (v.issuedAt < cut) {\n      sessions.delete(k);\n      dropped++;\n    }\n  }\n  return dropped;\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry changelog" },
  ],
  waitFor: { walkthrough: true, review: true, replyContains: ["📓 Changelog Entry"], timeoutMs: 240_000 },
  expect: { issueCommentContains: ["📓 Changelog Entry"] },
};
