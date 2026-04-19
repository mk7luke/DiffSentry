import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "risk-and-coverage",
  description:
    "PR touches a high-risk auth path and adds production code with no tests — walkthrough should include a Risk Assessment and a Test Coverage Signal flagging the gap.",
  prTitle: "Add password reset token issuance",
  prBody: "Issues a one-time password reset token tied to a user session.",
  files: [
    {
      path: "src/auth/password-reset.ts",
      content: `import crypto from "node:crypto";

const TOKENS = new Map<string, { userId: string; expiresAt: number }>();

export function issuePasswordResetToken(userId: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  TOKENS.set(token, { userId, expiresAt: Date.now() + 60 * 60 * 1000 });
  return token;
}

export function consumePasswordResetToken(token: string): string | null {
  const entry = TOKENS.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    TOKENS.delete(token);
    return null;
  }
  TOKENS.delete(token);
  return entry.userId;
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "## Risk Assessment",
      "Score:",
      "## Test Coverage Signal",
      "production code added with no test changes",
    ],
  },
};
