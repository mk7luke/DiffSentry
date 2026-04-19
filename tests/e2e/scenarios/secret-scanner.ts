import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "secret-scanner",
  description:
    "PR adds an AWS access key + GitHub token in source. Safety scanner should flag both with critical inline comments.",
  prTitle: "Wire up the staging deploy script",
  prBody: "Adds inline credentials so the staging deploy can authenticate. (Intentionally bad — for the secret-scanner test.)",
  files: [
    {
      path: "scripts/staging-deploy.sh",
      content: `#!/usr/bin/env bash
# Staging deploy — quick fix until Vault is wired up
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7TESTKEY
export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

aws s3 sync ./build s3://example-staging-bucket/
gh release create v0.0.0-test
`,
    },
  ],
  waitFor: { walkthrough: true, review: true, inlineCommentsAtLeast: 2, timeoutMs: 240_000 },
  expect: {
    reviewState: "CHANGES_REQUESTED",
    inlineCommentsContain: [
      { pathContains: "staging-deploy.sh", bodyContains: ["AWS Access Key"] },
      { pathContains: "staging-deploy.sh", bodyContains: ["GitHub Token"] },
    ],
  },
};
