import { describe, it, expect } from "vitest";
import { encodeState, extractState, replaceState, WalkthroughState } from "../../src/walkthrough-state.js";

/**
 * The walkthrough state blob is the one thing DiffSentry persists across
 * reviews, and it lives in a comment on someone else's PR — every blob ever
 * written is still out there and will be decoded by whatever code is deployed
 * when that PR next gets a push. A blob that stops decoding does not fail
 * loudly: `extractState` returns null, the next pass sees a PR it has never
 * reviewed, and re-posts every finding it ever made.
 *
 * `findingShas` (A9) is the first field added since the format shipped. These
 * tests pin the two properties that make adding one safe.
 */

/**
 * A blob encoded by the code as it stood at e284bcc, before `findingShas`
 * existed — every field the interface declared at that point, populated.
 *
 * Frozen as a literal rather than re-encoded from an object, so it stays a
 * record of what the old encoder actually emitted even if the current one
 * changes. Decoding is what must not break; gunzip is stable across Node
 * versions in a way gzip's byte output is not.
 */
const PRE_CHANGE_BLOB =
  "H4sIAAAAAAAAE21QTWvjQAz9K0bnsdeeOE7j27KlFLqFsulp2x7kGdkWdTzDjOIlhPz3xUkNpfQm8b70dIIJ6kLBgFH+0MT0j+yuR6hh265MgVbrpqR1W+Wb4kZvV3mJ66YyG3tD2zbHotGgoOWBdj1GqE8Qg/kRrkYhkwg19Omyg7rAHUt/aBbwusFZgXdRyN7x2FHwgceZ8AKtT3HwPc45Pm1IPqYO93uEt0X2FH7TRMMDHS+qOQczia/yyDHy2CVCURLjJgrYUQYKXuWWognshd2YGDdKQMtGYiI9JZbbNpvt53LxKThDMZJdvD9X/NpqEe3e2XuyO97zgGFRHkbT49iR/Yb6HHhiHBYq770LElM3DscPtg/0SKGjX+5w+c8JPF7vKhW0yMM8FmcFB29RyP4UqEHnukrzMi02z3lV66oudbZab/+CgsDx/Z6juHCE+qXQalWqdfF2/g+rMUELGAIAAA==";

const PRE_CHANGE_COMMENT = [
  "<!-- DiffSentry Walkthrough -->",
  "## Walkthrough",
  "",
  "A PR reviewed months ago.",
  "",
  "<!-- internal_state_start -->",
  `<!-- diffsentry-state:${PRE_CHANGE_BLOB}-->`,
  "<!-- internal_state_end -->",
].join("\n");

describe("a state blob written before findingShas existed", () => {
  it("still decodes, with every field it carried intact", () => {
    const state = extractState(PRE_CHANGE_COMMENT);

    expect(state).not.toBeNull();
    expect(state).toEqual({
      v: 1,
      lastReviewedSha: "9f3c1ad22b4e5f6071829304a5b6c7d8e9f0a1b2",
      fileShas: { "src/reviewer.ts": "h-reviewer", "src/github.ts": "h-github" },
      postedFingerprints: ["fp-alpha", "fp-beta", "fp-gamma"],
      postedPrLevelKeys: ["src/a.ts\tMissing test coverage.", "\tDescription contradicts the diff."],
      filesProcessed: ["src/reviewer.ts", "src/github.ts"],
      filesSkippedSimilar: ["src/unchanged.ts"],
      filesSkippedTrivial: ["src/imports-only.ts"],
      preMergeCounts: { passed: 4, failed: 1 },
      updatedAt: "2026-04-17T06:26:42.359Z",
      riskHistory: [12, 34, 51],
    });
  });

  it("carries the new field as absent rather than as a broken value", () => {
    // The consumers all read it as `state.findingShas?.[fp]`, so absent has to
    // mean "no range to name", never "undefined to undefined".
    expect(extractState(PRE_CHANGE_COMMENT)?.findingShas).toBeUndefined();
  });

  it("round-trips through a re-encode without losing a field", () => {
    // The push-auto-resolve path decodes, edits two lists, and writes the whole
    // object back. A field it doesn't know about must survive that, or an old
    // PR quietly loses its skip lists the first time a thread closes.
    const decoded = extractState(PRE_CHANGE_COMMENT)!;
    const reencoded = extractState(encodeState(decoded));

    expect(reencoded).toEqual(decoded);
  });

  it("survives replaceState in a comment, keeping the rest of the body byte-for-byte", () => {
    const next: WalkthroughState = { ...extractState(PRE_CHANGE_COMMENT)!, findingShas: { "fp-alpha": "abc1234" } };
    const after = replaceState(PRE_CHANGE_COMMENT, next);

    expect(extractState(after)).toEqual(next);
    expect(after).toContain("A PR reviewed months ago.");
    expect(after.startsWith("<!-- DiffSentry Walkthrough -->")).toBe(true);
    expect(after).toContain("<!-- internal_state_end -->");
  });
});

describe("a state blob written after findingShas exists", () => {
  it("decodes under code that predates the field, with everything else intact", () => {
    // The reverse direction, and the one a rollback depends on. `extractState`
    // gates on `v === 1` and casts; it never enumerates keys, so a field it has
    // never heard of rides along instead of rejecting the blob. This is why
    // `v` stays at 1 — bumping it would make exactly this case decode as null.
    const newShape: WalkthroughState = {
      v: 1,
      lastReviewedSha: "aaaaaaa",
      postedFingerprints: ["fp-alpha"],
      findingShas: { "fp-alpha": "bbbbbbb" },
    };
    const blob = encodeState(newShape);

    // Stand in for the old decoder: same `v` gate, no knowledge of findingShas.
    const decodedByOldCode = extractState(blob) as Record<string, unknown>;

    expect(decodedByOldCode.v).toBe(1);
    expect(decodedByOldCode.lastReviewedSha).toBe("aaaaaaa");
    expect(decodedByOldCode.postedFingerprints).toEqual(["fp-alpha"]);
  });
});
