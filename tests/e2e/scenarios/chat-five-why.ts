import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-five-why",
  description:
    "@diffsentry 5why <target> should reply with 5 levels of why + a Root cause section.",
  prTitle: "Bump fetch retry from 3 to 7 attempts",
  prBody:
    "Bumps the global fetch retry count to 7 because we keep getting flaky errors in CI from a third-party API.",
  files: [
    {
      path: "src/net/fetch.ts",
      content: `const MAX_RETRIES = 7;\n\nexport async function retryingFetch(url: string, init?: RequestInit, attempt = 0): Promise<Response> {\n  try {\n    return await fetch(url, init);\n  } catch (err) {\n    if (attempt >= MAX_RETRIES) throw err;\n    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));\n    return retryingFetch(url, init, attempt + 1);\n  }\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry 5why bumping the retry count from 3 to 7" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    botIssueCommentsAtLeast: 4,
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "Five Whys",
      "Why 1",
      "Why 5",
      "## Root cause",
    ],
  },
};
