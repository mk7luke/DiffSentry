import type { Scenario } from "../types.js";

export const scenario: Scenario = {
  name: "description-drift",
  description:
    "PR description claims to add caching + metrics, but the diff only adds a one-line helper. Walkthrough should embed a 🧭 Description Drift block.",
  prTitle: "Add response caching and Prometheus metrics",
  prBody:
    "This PR introduces an LRU cache for API responses (5-minute TTL) and exports Prometheus metrics for cache hit rate, request latency, and error counts. " +
    "The cache is wired into the user-lookup hot path. Metrics are scraped at /metrics with standard Prometheus formatting. " +
    "Closes the long-standing performance ticket on slow user lookups.",
  files: [
    {
      path: "src/util/identity.ts",
      content: `export function identity<T>(x: T): T {\n  return x;\n}\n`,
    },
  ],
  waitFor: { walkthrough: true, review: true, timeoutMs: 240_000 },
  expect: {
    walkthroughContains: [
      "🧭 Description Drift",
    ],
  },
};
