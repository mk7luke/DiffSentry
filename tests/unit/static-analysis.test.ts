import { describe, it, expect } from "vitest";
import {
  runStaticAnalysis,
  computeAddedLines,
  dedupeStaticFindings,
  resolveCheckoutDir,
} from "../../src/static-analysis.js";
import type { ReviewComment } from "../../src/types.js";

function comment(over: Partial<ReviewComment>): ReviewComment {
  return { path: "src/foo.ts", line: 10, side: "RIGHT", body: "b", ...over };
}

describe("computeAddedLines", () => {
  it("tracks only +-added RIGHT-side lines, honoring the hunk start", () => {
    const patch = ["@@ -1,2 +5,3 @@", " ctx", "+added a", "+added b"].join("\n");
    const added = computeAddedLines(patch);
    expect([...added].sort((a, b) => a - b)).toEqual([6, 7]);
    expect(added.has(5)).toBe(false); // context line, not added
  });

  it("ignores removed lines and file headers", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,3 +1,2 @@", "-gone", " keep", "+new"].join("\n");
    const added = computeAddedLines(patch);
    expect([...added]).toEqual([2]);
  });

  it("returns an empty set for an empty patch", () => {
    expect(computeAddedLines("").size).toBe(0);
  });
});

describe("dedupeStaticFindings", () => {
  it("drops static findings colliding with an existing finding at the same path:line", () => {
    const existing = [comment({ path: "a.ts", line: 5 })];
    const out = dedupeStaticFindings([comment({ path: "a.ts", line: 5, fingerprint: "x" })], existing);
    expect(out).toHaveLength(0);
  });

  it("keeps non-colliding findings and dedupes static-vs-static by location", () => {
    const out = dedupeStaticFindings(
      [
        comment({ path: "a.ts", line: 9, fingerprint: "y" }),
        comment({ path: "a.ts", line: 9, fingerprint: "z" }), // dup location
        comment({ path: "b.ts", line: 1, fingerprint: "w" }),
      ],
      [],
    );
    expect(out.map((c) => `${c.path}:${c.line}`)).toEqual(["a.ts:9", "b.ts:1"]);
  });
});

describe("resolveCheckoutDir", () => {
  it("returns undefined when no env var is set", () => {
    expect(resolveCheckoutDir({})).toBeUndefined();
  });

  it("returns the resolved dir when it exists", () => {
    expect(resolveCheckoutDir({ DIFFSENTRY_REPO_CHECKOUT_DIR: process.cwd() })).toBe(process.cwd());
  });

  it("returns undefined when the path is not a directory", () => {
    expect(resolveCheckoutDir({ DIFFSENTRY_REPO_CHECKOUT_DIR: "/no/such/dir/xyz123" })).toBeUndefined();
  });

  it("honors the legacy DIFFSENTRY_STATIC_ANALYSIS_DIR alias", () => {
    expect(resolveCheckoutDir({ DIFFSENTRY_STATIC_ANALYSIS_DIR: process.cwd() })).toBe(process.cwd());
  });
});

describe("runStaticAnalysis degrade paths (never throws, AI-only fallback)", () => {
  const files = [{ filename: "a.ts", patch: "@@ -1 +1 @@\n+x" }];

  it("no-ops when the feature is disabled", async () => {
    expect(await runStaticAnalysis({ files, config: { enabled: false } })).toEqual([]);
  });

  it("no-ops when enabled but no checkout dir is available", async () => {
    expect(await runStaticAnalysis({ files, config: { enabled: true } })).toEqual([]);
  });

  it("no-ops when the checkout dir does not exist", async () => {
    expect(
      await runStaticAnalysis({ files, checkoutDir: "/no/such/dir/xyz123", config: { enabled: true } }),
    ).toEqual([]);
  });

  it("no-ops when there are no changed files with patches", async () => {
    expect(await runStaticAnalysis({ files: [], checkoutDir: process.cwd(), config: { enabled: true } })).toEqual([]);
  });
});
