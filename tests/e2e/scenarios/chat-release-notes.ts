import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-release-notes",
  description: "@diffsentry release-notes should reply with a 📣 Release Notes section.",
  prTitle: "Faster login: parallel session fetch",
  prBody: "Logs the user in faster by parallelising the session fetch.",
  files: [
    {
      path: "src/auth/login.ts",
      content: `export async function login(userId: string): Promise<void> {\n  // pretend we now fetch session + user profile in parallel\n  await Promise.all([fetchSession(userId), fetchProfile(userId)]);\n}\nasync function fetchSession(_id: string) { /* ... */ }\nasync function fetchProfile(_id: string) { /* ... */ }\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry release-notes" },
  ],
  waitFor: { walkthrough: true, review: true, replyContains: ["📣 Release Notes"], timeoutMs: 240_000 },
  expect: { issueCommentContains: ["📣 Release Notes"] },
};
