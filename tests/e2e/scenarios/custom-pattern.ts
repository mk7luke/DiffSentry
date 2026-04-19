import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "custom-pattern",
  description:
    "Repo defines an anti_patterns rule banning console.log; PR adds one. Should flag with the configured message.",
  prTitle: "Wire trace logging into request handler",
  prBody: "Adds debug output to the request handler.",
  files: [
    {
      path: ".diffsentry.yaml",
      content: `reviews:
  profile: "chill"
  builtin_patterns: false
  anti_patterns:
    - name: "Stray console.log"
      pattern: "console\\\\.log\\\\("
      severity: "major"
      type: "issue"
      message: "We standardised on the structured logger; console.log skips levels and formatters."
      advice: "Use logger.debug / logger.info instead, with a context object."
`,
    },
    {
      path: "src/api/handler.ts",
      content: `import type { Request, Response } from "express";

export function handle(req: Request, res: Response): void {
  console.log("incoming request", req.path);
  res.status(200).send("ok");
}
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 1, timeoutMs: 240_000 },
  expect: {
    inlineCommentsContain: [
      {
        pathContains: "handler.ts",
        bodyContains: [
          "Stray console.log",
          "structured logger",
          "Project anti-pattern",
        ],
      },
    ],
  },
};
