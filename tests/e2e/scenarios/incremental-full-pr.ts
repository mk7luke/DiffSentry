import type { Scenario } from "../types.js";

// Regression: mk7luke/atlas-timeclock#89. A feature branch is reviewed, then a
// small follow-up commit lands that only touches a doc file. The incremental
// re-review used to see just that file while still reading a description of the
// whole feature — and reported the already-merged-into-the-branch backend work
// as never implemented, flipping an approved PR to CHANGES_REQUESTED.
//
// The follow-up commit here is deliberately docs-only, exactly as in #89: the
// bot must reconcile the description against the whole branch, not the delta.
export const scenario: Scenario = {
  name: "incremental-full-pr",
  description:
    "Feature PR, then a docs-only follow-up commit. The incremental re-review must not claim the feature described in the PR body is missing from the diff.",
  prTitle: "Add a retry helper with backoff",
  prBody:
    "Adds `withRetry()` in `src/util/retry.ts` — exponential backoff with a configurable attempt cap — " +
    "and wires it into the fetch helper in `src/util/fetch-json.ts` so transient 5xx responses are retried. " +
    "Includes the default backoff table and the caller-facing options type.",
  files: [
    {
      path: "src/util/retry.ts",
      content: `export interface RetryOptions {\n  attempts?: number;\n  baseMs?: number;\n}\n\nexport async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {\n  const attempts = opts.attempts ?? 3;\n  const baseMs = opts.baseMs ?? 100;\n  let lastErr: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (err) {\n      lastErr = err;\n      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));\n    }\n  }\n  throw lastErr;\n}\n`,
    },
    {
      path: "src/util/fetch-json.ts",
      content: `import { withRetry } from "./retry.js";\n\nexport async function fetchJson<T>(url: string): Promise<T> {\n  return withRetry(async () => {\n    const res = await fetch(url);\n    if (res.status >= 500) throw new Error("transient " + res.status);\n    return (await res.json()) as T;\n  });\n}\n`,
    },
  ],
  postPrActions: [
    // Let the first review land and embed its state blob.
    { type: "wait", ms: 60_000 },
    {
      type: "push",
      commitMessage: "Document the retry helper",
      files: [
        {
          path: "docs/retry.md",
          content: `# Retry helper\n\n\`withRetry()\` retries a promise-returning function with exponential backoff.\n\n- \`attempts\` — total tries, default 3.\n- \`baseMs\` — first delay in ms, doubling per attempt, default 100.\n`,
        },
      ],
    },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 360_000,
  },
  expect: {
    // The incremental review sees only docs/retry.md as changed, so it must be
    // told the rest of the PR is already in place.
    reviewBodyContains: ["Reviewing files that changed from"],
    // The exact phrasing the old bug produced. None of these may appear.
    reviewBodyNotContains: [
      "missing from the diff",
      "is not implemented",
      "does not exist in the diff",
    ],
  },
};
