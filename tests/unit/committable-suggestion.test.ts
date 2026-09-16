import { describe, it, expect } from "vitest";
import {
  buildReviewComment,
  getDiffLineInfo,
  isCommittableSuggestion,
  renderSuggestionBlock,
} from "../../src/ai/parse.js";

/**
 * A patch whose right-hand side is:
 *
 *   50  export function renderMarkdown(input: string): string {
 *   51    try {
 *   52      return sanitizeHtml(marked.parse(input) as string, SANITIZE_OPTIONS);
 *   53    } catch {
 *   54      return input
 *   55        .replace(/&/g, "&amp;")
 *   56        .replace(/\n/g, "<br>");
 *   57    }
 *   58  }
 */
const PATCH = [
  "@@ -50,4 +50,9 @@",
  " export function renderMarkdown(input: string): string {",
  "   try {",
  "+    return sanitizeHtml(marked.parse(input) as string, SANITIZE_OPTIONS);",
  "   } catch {",
  "+    return input",
  "+      .replace(/&/g, \"&amp;\")",
  "+      .replace(/\\n/g, \"<br>\");",
  "   }",
  " }",
].join("\n");

const INFO = getDiffLineInfo(PATCH);

describe("getDiffLineInfo line text", () => {
  it("records the source text of every commentable right-side line", () => {
    expect(INFO.text.get(50)).toBe("export function renderMarkdown(input: string): string {");
    expect(INFO.text.get(52)).toBe("    return sanitizeHtml(marked.parse(input) as string, SANITIZE_OPTIONS);");
    expect(INFO.text.get(54)).toBe("    return input");
  });

  it("strips the diff marker but preserves indentation exactly", () => {
    expect(INFO.text.get(55)).toBe("      .replace(/&/g, \"&amp;\")");
  });
});

describe("isCommittableSuggestion", () => {
  it("accepts a verbatim single-line replacement for the anchored line", () => {
    const ok = isCommittableSuggestion(
      "    return sanitizeHtml(marked.parse(input) as string, STRICT_OPTIONS);",
      52,
      INFO,
    );
    expect(ok).toBe(true);
  });

  it("accepts a multi-line replacement that stays clear of the lines below", () => {
    const ok = isCommittableSuggestion(
      ["    const html = marked.parse(input) as string;", "    return sanitizeHtml(html, SANITIZE_OPTIONS);"].join("\n"),
      52,
      INFO,
    );
    expect(ok).toBe(true);
  });

  // The failure this whole check exists for: the model writes a replacement for
  // a block, we anchor it to the block's first line, and "Commit suggestion"
  // leaves the rest of the block in place.
  it("rejects a replacement that restates lines below its anchor", () => {
    const overruns = [
      "    return input",
      "      .replace(/&/g, \"&amp;\")",
      "      .replace(/\\n/g, \"<br>\");",
    ].join("\n");
    expect(isCommittableSuggestion(overruns, 54, INFO)).toBe(false);
  });

  // R4's known false-negative class, closed. A block-scoped fix in a braces
  // language ends on a delimiter that almost always recurs just below the
  // anchor; treating that as overlap left the apply button working mainly for
  // one-line edits. See isStructuralOnlyLine.
  it("accepts a block-scoped fix that shares only a closing delimiter", () => {
    // Right-side lines: 10 `list.forEach((x) => {`, 11 `  send(x);`,
    // 12 `});`, 13 `flush();`, 14 `});`.
    const info = getDiffLineInfo(
      [
        "@@ -10,5 +10,5 @@",
        "+list.forEach((x) => {",
        "   send(x);",
        " });",
        " flush();",
        " });",
      ].join("\n"),
    );
    const fix = ["list.forEach((x) => {", "  if (x != null) send(x);", "});"].join("\n");
    expect(isCommittableSuggestion(fix, 10, info)).toBe(true);
  });

  it("still rejects when the shared line carries semantics", () => {
    const info = getDiffLineInfo(
      [
        "@@ -10,4 +10,4 @@",
        "+if (x) {",
        "   send(x);",
        " } else {",
        " }",
      ].join("\n"),
    );
    // `} else {` has letters, so it is not structural-only and still counts.
    const fix = ["if (x != null) {", "  send(x);", "} else {"].join("\n");
    expect(isCommittableSuggestion(fix, 10, info)).toBe(false);
  });

  // Pinned against the one real DiffSentry suggestion in the captured corpus
  // (tests/e2e/reference/2026-09/diffsentry/inline.md:52) — the case R4 exists
  // for. It must keep failing after the structural-line exclusion: it restates
  // `SANITIZE_OPTIONS,` and a `.replace(…)` line, neither of which is
  // structural-only. Only its trailing `);` would now be forgiven.
  it("still catches the captured corpus case after the structural exclusion", () => {
    const info = getDiffLineInfo(
      [
        "@@ -53,7 +53,7 @@",
        "+    return sanitizeHtml(",
        "       input",
        "         .replace(/&/g, \"&amp;\")",
        "         .replace(/\\n/g, \"<br>\"),",
        "       SANITIZE_OPTIONS,",
        "     );",
      ].join("\n"),
    );
    const captured = [
      "    return sanitizeHtml(",
      "      input",
      "        .replace(/&/g, \"&amp;\")",
      "        .replace(/\\n/g, \"<br>\"),",
      "      SANITIZE_OPTIONS,",
      "    );",
    ].join("\n");
    expect(isCommittableSuggestion(captured, 53, info)).toBe(false);
  });

  it("rejects a unified diff, whose markers would be committed literally", () => {
    const asDiff = [
      "-    return sanitizeHtml(marked.parse(input) as string, SANITIZE_OPTIONS);",
      "+    return sanitizeHtml(marked.parse(input) as string, STRICT_OPTIONS);",
    ].join("\n");
    expect(isCommittableSuggestion(asDiff, 52, INFO)).toBe(false);
  });

  it("rejects a hunk header", () => {
    expect(isCommittableSuggestion("@@ -52,1 +52,1 @@\n    return 1;", 52, INFO)).toBe(false);
  });

  it("rejects a replacement whose indentation does not match the line it replaces", () => {
    expect(
      isCommittableSuggestion("return sanitizeHtml(marked.parse(input) as string, STRICT_OPTIONS);", 52, INFO),
    ).toBe(false);
  });

  it("rejects a line the patch does not cover", () => {
    expect(isCommittableSuggestion("    return 1;", 900, INFO)).toBe(false);
  });

  it("rejects an empty suggestion", () => {
    expect(isCommittableSuggestion("   \n  ", 52, INFO)).toBe(false);
  });
});

describe("buildReviewComment suggestion language", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    path: "src/dashboard/markdown.ts",
    line: 52,
    body: "Use the strict option set here.",
    title: "Tighten the sanitizer options.",
    severity: "major",
    suggestion: "    return sanitizeHtml(marked.parse(input) as string, STRICT_OPTIONS);",
    ...over,
  });

  it("renders a committable suggestion when the replacement matches its anchor", () => {
    const c = buildReviewComment(raw(), { path: "src/dashboard/markdown.ts", line: 52, prLevel: false }, INFO);
    expect(c.suggestionLanguage).toBe("suggestion");
    expect(c.body).toContain("📝 Committable suggestion");
    expect(c.body).toContain("```suggestion");
    expect(c.body).not.toContain("```diff");
  });

  it("falls back to a diff fence when the replacement overruns its anchor", () => {
    const overruns = [
      "    return input",
      "      .replace(/&/g, \"&amp;\")",
      "      .replace(/\\n/g, \"<br>\");",
    ].join("\n");
    const c = buildReviewComment(
      raw({ line: 54, suggestion: overruns }),
      { path: "src/dashboard/markdown.ts", line: 54, prLevel: false },
      INFO,
    );
    expect(c.suggestionLanguage).toBe("diff");
    expect(c.body).toContain("```diff");
    expect(c.body).not.toContain("```suggestion");
  });

  it("honours an explicit diff language without validating it", () => {
    const c = buildReviewComment(
      raw({ suggestionLanguage: "diff" }),
      { path: "src/dashboard/markdown.ts", line: 52, prLevel: false },
      INFO,
    );
    expect(c.suggestionLanguage).toBe("diff");
  });

  // A PR-level or file-level finding is anchored to line 0, so GitHub has no
  // range to replace and the apply affordance would have nothing to apply to.
  it("never offers a committable fence on a finding with no line anchor", () => {
    const c = buildReviewComment(
      raw({ line: 0 }),
      { path: "src/dashboard/markdown.ts", line: 0, prLevel: true },
      INFO,
    );
    expect(c.suggestionLanguage).toBe("diff");
  });

  it("falls back to a diff fence when the caller has no diff geometry", () => {
    const c = buildReviewComment(raw(), { path: "src/dashboard/markdown.ts", line: 52, prLevel: false });
    expect(c.suggestionLanguage).toBe("diff");
  });
});

describe("renderSuggestionBlock", () => {
  it("wraps a committable fence in the review-before-committing caveat", () => {
    const block = renderSuggestionBlock("  return 1;", "suggestion");
    expect(block).toContain("<summary>📝 Committable suggestion</summary>");
    expect(block).toContain("> ‼️ **IMPORTANT**");
    expect(block).toContain("```suggestion\n  return 1;\n```");
  });

  it("leaves the diff fence as the plain proposed-fix collapse", () => {
    const block = renderSuggestionBlock("-a\n+b", "diff");
    expect(block).toContain("<summary>🔧 Proposed fix</summary>");
    expect(block).not.toContain("‼️");
  });
});
