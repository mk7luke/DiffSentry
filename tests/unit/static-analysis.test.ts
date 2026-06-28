import { describe, it, expect } from "vitest";
import {
  runStaticAnalysis,
  computeAddedLines,
  dedupeStaticFindings,
  resolveCheckoutDir,
  toRepoRelative,
  parseTscDiagnostics,
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

  it("ignores added lines that appear before the first hunk header (no line 0)", () => {
    const malformed = ["+stray pre-hunk line", "@@ -1,1 +1,2 @@", " ctx", "+real"].join("\n");
    const added = computeAddedLines(malformed);
    expect([...added]).toEqual([2]);
    expect(added.has(0)).toBe(false);
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

describe("parseTscDiagnostics", () => {
  it("parses a standard POSIX diagnostic line", () => {
    const out = parseTscDiagnostics("src/foo.ts(12,5): error TS2322: Type 'x' is not assignable to 'y'.");
    expect(out).toEqual([
      { file: "src/foo.ts", line: 12, ruleId: "TS2322", message: "Type 'x' is not assignable to 'y'.", level: "error" },
    ]);
  });

  it("parses a Windows absolute path (drive-letter colon, backslashes)", () => {
    const out = parseTscDiagnostics("C:\\repo\\src\\foo.ts(7,1): error TS1005: ';' expected.");
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("C:\\repo\\src\\foo.ts");
    expect(out[0].line).toBe(7);
    expect(out[0].ruleId).toBe("TS1005");
  });

  it("handles parentheses inside the filename via greedy backtracking", () => {
    const out = parseTscDiagnostics("src/some(weird).ts(3,9): warning TS6133: 'x' is declared but never used.");
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/some(weird).ts");
    expect(out[0].line).toBe(3);
    expect(out[0].level).toBe("warning");
  });

  it("ignores summary/non-diagnostic lines and blank input", () => {
    const out = parseTscDiagnostics("Found 2 errors in 1 file.\n\n   src/ok.ts:not-a-diagnostic");
    expect(out).toEqual([]);
  });
});

describe("toRepoRelative", () => {
  const cwd = "/repo/checkout";

  it("maps a plain relative path to a POSIX repo-relative path", () => {
    expect(toRepoRelative("src/foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("maps a ./-prefixed relative path (common analyzer output)", () => {
    expect(toRepoRelative("./src/foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("maps an absolute path inside the checkout", () => {
    expect(toRepoRelative("/repo/checkout/src/foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("folds . and .. segments that stay inside the checkout", () => {
    expect(toRepoRelative("/repo/checkout/sub/../src/foo.ts", cwd)).toBe("src/foo.ts");
    expect(toRepoRelative("src/./bar/../foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("rejects paths that escape the checkout", () => {
    expect(toRepoRelative("../outside.ts", cwd)).toBeNull();
    expect(toRepoRelative("/etc/passwd", cwd)).toBeNull();
  });

  it("rejects the checkout root itself (no file)", () => {
    expect(toRepoRelative("", cwd)).toBeNull();
    expect(toRepoRelative(".", cwd)).toBeNull();
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
