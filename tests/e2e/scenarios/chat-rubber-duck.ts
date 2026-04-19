import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "chat-rubber-duck",
  description:
    "@diffsentry rubber-duck should reply with 3 Socratic questions plus an unasked question.",
  prTitle: "Switch from polling to webhooks for build status",
  prBody:
    "Replaces the 5-second poll loop with a webhook receiver. Removes the in-memory build cache because webhook events arrive faster than the cache TTL.",
  files: [
    {
      path: "src/build/webhook.ts",
      content: `import { Request, Response } from "express";\n\nexport function buildWebhook(req: Request, res: Response): void {\n  const event = req.body;\n  if (event.action === "completed") {\n    // dispatch internal job\n  }\n  res.status(200).send("ok");\n}\n`,
    },
    {
      path: "src/build/poll.ts",
      content: `// Deprecated — kept only for the legacy CLI flag.\nexport async function pollBuildStatus(): Promise<void> {\n  // intentionally empty after webhook switch\n}\n`,
    },
  ],
  postPrActions: [
    { type: "wait", ms: 30_000 },
    { type: "comment", body: "@diffsentry rubber-duck" },
  ],
  waitFor: {
    walkthrough: true,
    review: true,
    replyContains: ["🦆 Rubber Duck"],
    timeoutMs: 240_000,
  },
  expect: {
    issueCommentContains: [
      "🦆 Rubber Duck",
      "🦆 Question 1",
      "unasked question",
    ],
  },
};
