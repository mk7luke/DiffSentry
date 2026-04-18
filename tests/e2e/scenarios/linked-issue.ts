import type { Scenario } from "../types.js";

// Issue #62 in mk7luke/diffsentry-sandbox is a standing issue created for this
// scenario. It describes a race condition in payment retry logic — the AI
// should fetch and reference its content when reviewing the PR.
const ISSUE_NUMBER = 62;

export const scenario: Scenario = {
  name: "linked-issue",
  description:
    "PR description references 'fixes #N' — bot should fetch the issue and incorporate its context into review/walkthrough.",
  prTitle: "Add idempotency key to payment retry",
  prBody: `Adds an idempotency key check to the payment retry endpoint so concurrent retries from multiple workers cannot double-charge.\n\nfixes #${ISSUE_NUMBER}`,
  files: [
    {
      path: "src/payments/retry.ts",
      content: `interface RetryRequest {\n  paymentId: string;\n  amount: number;\n  idempotencyKey?: string;\n}\n\nconst recentKeys = new Set<string>();\n\nexport async function retryPayment(req: RetryRequest): Promise<{ ok: boolean }> {\n  if (!req.idempotencyKey) {\n    throw new Error("idempotencyKey is required");\n  }\n  if (recentKeys.has(req.idempotencyKey)) {\n    return { ok: true };\n  }\n  recentKeys.add(req.idempotencyKey);\n  // ... existing payment retry logic\n  return { ok: true };\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "## Linked Issues",
      `#${ISSUE_NUMBER}`,
    ],
  },
};
