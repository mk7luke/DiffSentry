import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "multi-file-cohorts",
  description:
    "Multi-area diff (config + util + docs) — walkthrough should group files into cohorts in the Changes table.",
  prTitle: "Add rate limiter and update build config",
  prBody:
    "Introduces a token-bucket rate limiter, wires it into the build config, and updates docs.",
  files: [
    {
      path: "src/util/rate-limit.ts",
      content: `export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(private readonly capacity: number, private readonly refillPerMs: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const delta = (now - this.last) * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + delta);
    this.last = now;
  }
}
`,
    },
    {
      path: "src/util/index.ts",
      content: `export { RateLimiter } from './rate-limit.js';
`,
    },
    {
      path: "config/build.json",
      content: `{
  "compiler": "swc",
  "rateLimit": {
    "capacity": 100,
    "refillPerMs": 0.05
  }
}
`,
    },
    {
      path: "docs/rate-limiting.md",
      content: `# Rate limiting\n\nProduction routes use a token-bucket limiter. Defaults live in \`config/build.json\`.\n`,
    },
    {
      path: "README.md",
      content: `# Sandbox\n\nE2E sandbox for DiffSentry. See \`docs/rate-limiting.md\` for the new limiter.\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "Cohort / File(s)",
      "🎯",
      "minutes",
    ],
  },
};
