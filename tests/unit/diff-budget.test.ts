import { describe, it, expect } from "vitest";
import { applyDiffBudget, truncatePatch, resolveDiffBudget } from "../../src/ai/diff-budget.js";

/** Build a unified-diff patch with `n` added body lines under one hunk header. */
function patchWithLines(n: number, prefix = "added line"): string {
  const body = Array.from({ length: n }, (_, i) => `+${prefix} ${i}`);
  return [`@@ -1,1 +1,${n} @@`, ...body].join("\n");
}

describe("truncatePatch", () => {
  it("returns the patch untouched when it already fits", () => {
    const patch = patchWithLines(5);
    const out = truncatePatch(patch, { perFileChars: 10_000, keepHeadLines: 40, keepTailLines: 20 });
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(patch);
  });

  it("keeps the hunk header plus a head/tail and marks the gap", () => {
    const patch = patchWithLines(500);
    const out = truncatePatch(patch, { perFileChars: 800, keepHeadLines: 10, keepTailLines: 5 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(800);
    // Header preserved
    expect(out.text).toContain("@@ -1,1 +1,500 @@");
    // Head + tail lines present
    expect(out.text).toContain("+added line 0");
    expect(out.text).toContain("+added line 499");
    // Middle dropped
    expect(out.text).not.toContain("+added line 250");
    expect(out.text).toMatch(/omitted from this hunk/);
  });

  it("hard-caps even a single pathological hunk", () => {
    const patch = patchWithLines(50_000);
    const out = truncatePatch(patch, { perFileChars: 500, keepHeadLines: 10_000, keepTailLines: 10_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(500 + 60); // budget + the hard-truncation marker
  });

  it("drops whole later hunks when per-hunk trimming isn't enough", () => {
    const hunks = Array.from({ length: 20 }, (_, h) =>
      [`@@ -${h * 10},1 +${h * 10},5 @@`, "+a", "+b", "+c", "+d", "+e"].join("\n"),
    );
    const patch = hunks.join("\n");
    const out = truncatePatch(patch, { perFileChars: 120, keepHeadLines: 40, keepTailLines: 20 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(120 + 80);
    expect(out.text).toMatch(/later hunk\(s\) omitted entirely/);
  });
});

describe("resolveDiffBudget", () => {
  it("applies defaults and treats undefined as enabled", () => {
    const r = resolveDiffBudget(undefined);
    expect(r.enabled).toBe(true);
    expect(r.perFileChars).toBe(24_000);
    expect(r.perReviewChars).toBe(180_000);
  });

  it("honors overrides and rejects negative/non-numeric values", () => {
    const r = resolveDiffBudget({ enabled: false, per_file_chars: 100, per_review_chars: -5 });
    expect(r.enabled).toBe(false);
    expect(r.perFileChars).toBe(100);
    expect(r.perReviewChars).toBe(180_000); // negative falls back to default
  });
});

describe("applyDiffBudget", () => {
  it("passes files through untouched when disabled", () => {
    const files = [{ filename: "a.ts", patch: patchWithLines(5_000) }];
    const res = applyDiffBudget(files, { enabled: false });
    expect(res.enabled).toBe(false);
    expect(res.filesTruncated).toEqual([]);
    expect(res.filesOmitted).toEqual([]);
    expect(res.byFile["a.ts"].patch).toBe(files[0].patch);
  });

  it("truncates a single oversized file", () => {
    const files = [{ filename: "a.ts", patch: patchWithLines(5_000) }];
    const res = applyDiffBudget(files, { per_file_chars: 1_000, per_review_chars: 1_000_000 });
    expect(res.filesTruncated).toEqual(["a.ts"]);
    expect(res.filesOmitted).toEqual([]);
    expect(res.byFile["a.ts"].sentChars).toBeLessThanOrEqual(1_000 + 60);
  });

  it("omits lower-priority files when the per-review budget is exceeded, keeping high-risk first", () => {
    const files = [
      { filename: "src/util/big.ts", patch: patchWithLines(60) },
      { filename: "src/auth/login.ts", patch: patchWithLines(60) },
      { filename: "src/util/other.ts", patch: patchWithLines(60) },
    ];
    // Budget big enough for ~1 file's worth of content. per_file_chars is set
    // to a single file's size so files aren't truncated AND so it doesn't act
    // as the effective-budget floor (which is max(per_file, per_review-related)).
    const oneFileChars = files[0].patch.length;
    const res = applyDiffBudget(files, {
      per_file_chars: oneFileChars,
      per_review_chars: oneFileChars + 5,
    });
    // The high-risk auth file must survive; at least one lower-risk file dropped.
    expect(res.filesOmitted.length).toBeGreaterThanOrEqual(1);
    expect(res.byFile["src/auth/login.ts"].omitted).toBe(false);
    expect(res.filesOmitted).not.toContain("src/auth/login.ts");
  });

  it("always sends at least the top-ranked file even past the budget", () => {
    const files = [{ filename: "a.ts", patch: patchWithLines(5_000) }];
    const res = applyDiffBudget(files, { per_file_chars: 50_000, per_review_chars: 1 });
    expect(res.filesOmitted).toEqual([]);
    expect(res.byFile["a.ts"].omitted).toBe(false);
  });

  it("reserves room for related context out of the per-review budget", () => {
    const files = [
      { filename: "a.ts", patch: patchWithLines(40) },
      { filename: "b.ts", patch: patchWithLines(40) },
    ];
    const each = files[0].patch.length;
    // Without reservation both fit; reserving most of the budget forces an omit.
    // per_file_chars = each so files aren't truncated and the floor stays low.
    const res = applyDiffBudget(
      files,
      { per_file_chars: each, per_review_chars: each * 2 + 10 },
      { relatedContextChars: each + 5 },
    );
    expect(res.effectivePerReviewChars).toBeLessThan(each * 2 + 10);
    expect(res.filesOmitted.length).toBe(1);
  });
});
