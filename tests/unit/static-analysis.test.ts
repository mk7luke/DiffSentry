import { describe, it, expect } from "vitest";
import {
  runStaticAnalysis,
  computeAddedLines,
  dedupeStaticFindings,
  resolveCheckoutDir,
  toRepoRelative,
  parseTscDiagnostics,
  resolveSpawn,
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

  it("ignores the '\\ No newline at end of file' sentinel (keeps line numbers exact)", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-old line",
      "\\ No newline at end of file",
      "+new line",
      "\\ No newline at end of file",
    ].join("\n");
    const added = computeAddedLines(patch);
    // "+new line" is right-side line 1; the sentinel must not have bumped it to 2.
    expect([...added]).toEqual([1]);
  });

  it("does not attribute lines in a zero-length (+N,0) addition hunk", () => {
    // Pure deletion hunk: right-side count is 0, so nothing is added even if a
    // stray "+" line follows (malformed/tool-generated).
    const patch = ["@@ -10,2 +9,0 @@", "-a", "-b", "+stray"].join("\n");
    expect([...computeAddedLines(patch)]).toEqual([]);
  });

  it("stops attributing once a hunk's declared right-side span is exhausted", () => {
    // Header declares 1 right-side line; the second "+" is beyond the span.
    const patch = ["@@ -1,1 +1,1 @@", "+only", "+overflow"].join("\n");
    expect([...computeAddedLines(patch)]).toEqual([1]);
  });

  it("keeps later-hunk line numbers correct after a no-newline sentinel", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "\\ No newline at end of file",
      "+a2",
      "@@ -10,1 +10,2 @@",
      " ctx",
      "+b",
    ].join("\n");
    expect([...computeAddedLines(patch)].sort((x, y) => x - y)).toEqual([1, 11]);
  });
});

describe("resolveSpawn (Windows .cmd shim routing)", () => {
  it("spawns native/POSIX commands directly", () => {
    expect(resolveSpawn("/repo/node_modules/.bin/eslint", ["a.ts"], "linux")).toEqual({
      command: "/repo/node_modules/.bin/eslint",
      args: ["a.ts"],
    });
  });

  it("routes Windows .cmd/.bat shims through cmd.exe", () => {
    expect(resolveSpawn("C:\\repo\\node_modules\\.bin\\eslint.cmd", ["a.ts"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:\\repo\\node_modules\\.bin\\eslint.cmd", "a.ts"],
    });
    expect(resolveSpawn("tsc.bat", [], "win32").command).toBe("cmd.exe");
  });

  it("does not wrap .cmd on non-Windows platforms", () => {
    expect(resolveSpawn("eslint.cmd", [], "linux")).toEqual({ command: "eslint.cmd", args: [] });
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

  it("folds indented message-chain continuation lines into the message", () => {
    const text = [
      "src/foo.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
      "  Types of property 'x' are incompatible.",
      "    Type 'string' is not assignable to type 'number'.",
      "Found 1 error.",
    ].join("\n");
    const out = parseTscDiagnostics(text);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe(
      "Type 'A' is not assignable to type 'B'. Types of property 'x' are incompatible. Type 'string' is not assignable to type 'number'.",
    );
    // The non-indented "Found 1 error." summary must not be absorbed.
    expect(out[0].message).not.toContain("Found 1 error");
  });

  it("maps suggestion/message categories to the info level", () => {
    const out = parseTscDiagnostics(
      [
        "src/a.ts(1,1): suggestion TS80001: File is a CommonJS module; it may be converted to an ES module.",
        "src/b.ts(2,2): message TS6133: 'x' is declared but its value is never read.",
      ].join("\n"),
    );
    expect(out.map((f) => f.level)).toEqual(["info", "info"]);
    expect(out[0].ruleId).toBe("TS80001");
  });

  it("keeps consecutive diagnostics separate", () => {
    const text = [
      "a.ts(1,1): error TS1: first.",
      "  detail for first.",
      "b.ts(2,2): warning TS2: second.",
    ].join("\n");
    const out = parseTscDiagnostics(text);
    expect(out.map((f) => f.ruleId)).toEqual(["TS1", "TS2"]);
    expect(out[0].message).toBe("first. detail for first.");
    expect(out[1].message).toBe("second.");
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

  it("maps repo-root files (not just nested ones)", () => {
    // A file at the checkout root resolves to its basename, NOT an empty string,
    // so it is correctly kept (it does not look like the directory itself).
    expect(toRepoRelative("eslint.config.js", cwd)).toBe("eslint.config.js");
    expect(toRepoRelative("./index.ts", cwd)).toBe("index.ts");
    expect(toRepoRelative("/repo/checkout/index.ts", cwd)).toBe("index.ts");
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
