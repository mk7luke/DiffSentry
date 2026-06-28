import { describe, it, expect } from "vitest";
import { fingerprintFor, normalizeForFingerprint } from "../../src/ai/parse.js";

describe("normalizeForFingerprint", () => {
  it("collapses case, punctuation, and whitespace", () => {
    expect(normalizeForFingerprint("  Missing   NULL-check!! ")).toBe("missing null check");
  });

  it("preserves the full title rather than truncating to a token prefix", () => {
    // Two findings that share their first 12 tokens but diverge afterwards.
    // Under the old `.slice(0, 12)` normalization these collapsed to the same
    // string; now the tail is retained so they stay distinct.
    const a =
      "Unchecked array access on the request body can throw when the field is missing";
    const b =
      "Unchecked array access on the request body can throw when the header is missing";
    expect(normalizeForFingerprint(a)).not.toBe(normalizeForFingerprint(b));
  });
});

describe("fingerprintFor", () => {
  const path = "src/handler.ts";
  const line = 42;

  it("gives distinct fingerprints to findings that differ only past the 12th token", () => {
    // These two example titles are identical for the first 12 tokens and only
    // differ in the final word — exactly the case that used to be deduped away.
    const titleA =
      "Unchecked array access on the request body can throw when the field is missing";
    const titleB =
      "Unchecked array access on the request body can throw when the header is missing";

    expect(fingerprintFor(path, line, titleA)).not.toBe(
      fingerprintFor(path, line, titleB),
    );
  });

  it("still collides on re-indentation and case-only changes (trivial re-wording)", () => {
    const title = "Potential null dereference when config is absent";
    const reindented = `\t  ${title.replace(/ /g, "   ")}  `;
    const recased = title.toUpperCase();

    const base = fingerprintFor(path, line, title);
    expect(fingerprintFor(path, line, reindented)).toBe(base);
    expect(fingerprintFor(path, line, recased)).toBe(base);
  });

  it("keeps path and line in the key so identical titles elsewhere stay distinct", () => {
    const title = "Potential null dereference when config is absent";
    expect(fingerprintFor("src/a.ts", line, title)).not.toBe(
      fingerprintFor("src/b.ts", line, title),
    );
    expect(fingerprintFor(path, 10, title)).not.toBe(
      fingerprintFor(path, 99, title),
    );
  });
});
