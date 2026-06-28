import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { normalizePatchForHash } from "../../src/reviewer.js";

// `patchHash` is internal to reviewer.ts, but it is a pure function of
// `normalizePatchForHash` (sha256 of the normalized string, truncated). So two
// patches hash identically iff they normalize identically — we assert on the
// normalized form (and spot-check the actual digest) to prove collision
// resistance.
function hash(filename: string, patch: string): string {
  return createHash("sha256")
    .update(normalizePatchForHash(filename, patch))
    .digest("hex")
    .slice(0, 16);
}

describe("normalizePatchForHash", () => {
  // The two patches below touch the same file and the same line content. The
  // only difference is direction: the first *adds* `const y = 2;`, the second
  // *removes* it. Under the old normalization (which stripped +/- markers)
  // these collapsed to the identical string and collided — so an incremental
  // review would wrongly treat a removal as "unchanged" from a prior addition.
  const added = [
    "@@ -1,2 +1,3 @@",
    " const x = 1;",
    "+const y = 2;",
    " const z = 3;",
  ].join("\n");

  const removed = [
    "@@ -1,3 +1,2 @@",
    " const x = 1;",
    "-const y = 2;",
    " const z = 3;",
  ].join("\n");

  it("hashes add vs remove of the same line differently", () => {
    expect(normalizePatchForHash("src/a.ts", added)).not.toBe(
      normalizePatchForHash("src/a.ts", removed),
    );
    expect(hash("src/a.ts", added)).not.toBe(hash("src/a.ts", removed));
  });

  it("hashes the same patch differently across different files", () => {
    expect(normalizePatchForHash("src/a.ts", added)).not.toBe(
      normalizePatchForHash("src/b.ts", added),
    );
    expect(hash("src/a.ts", added)).not.toBe(hash("src/b.ts", added));
  });

  it("still treats trivial whitespace reflows as equal", () => {
    // Same file, same change direction, only re-indented / re-spaced.
    const reindented = [
      "@@ -1,2 +1,3 @@",
      "   const x   =   1;",
      "+    const y = 2;",
      "   const z = 3;",
    ].join("\n");
    expect(normalizePatchForHash("src/a.ts", added)).toBe(
      normalizePatchForHash("src/a.ts", reindented),
    );
    expect(hash("src/a.ts", added)).toBe(hash("src/a.ts", reindented));
  });
});
