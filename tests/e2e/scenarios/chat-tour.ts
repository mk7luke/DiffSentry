import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-tour",
  description:
    "@diffsentry tour should reply with a reading-order guide across the changed files and a Final Check section.",
  prTitle: "Refactor session storage",
  prBody:
    "Extracts session storage into a dedicated module and updates the two callers that import it.",
  files: [
    {
      path: "src/session/storage.ts",
      content: `export interface Session {\n  id: string;\n  userId: string;\n  issuedAt: number;\n}\n\nconst SESSIONS = new Map<string, Session>();\n\nexport function putSession(s: Session): void {\n  SESSIONS.set(s.id, s);\n}\n\nexport function getSession(id: string): Session | null {\n  return SESSIONS.get(id) ?? null;\n}\n`,
    },
    {
      path: "src/session/auth.ts",
      content: `import { getSession, putSession } from "./storage.js";\n\nexport function authenticate(id: string, userId: string): void {\n  putSession({ id, userId, issuedAt: Date.now() });\n}\n\nexport function currentUser(id: string): string | null {\n  return getSession(id)?.userId ?? null;\n}\n`,
    },
    {
      path: "src/session/middleware.ts",
      content: `import { currentUser } from "./auth.js";\n\nexport function requireAuth(sessionId: string | undefined): string {\n  if (!sessionId) throw new Error("Unauthenticated");\n  const user = currentUser(sessionId);\n  if (!user) throw new Error("Invalid session");\n  return user;\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry tour" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    replyContains: ["🗺️ Code Tour"],
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "🗺️ Code Tour",
      "## Final Check",
    ],
  },
};
