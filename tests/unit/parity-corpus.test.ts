import { describe, it, expect } from "vitest";
import { classifySurface, type CapturedComment } from "../../src/parity/corpus.js";

function c(over: Partial<CapturedComment>): CapturedComment {
  return { kind: "issue", body: "", author: "coderabbitai[bot]", createdAt: "2026-09-01T00:00:00Z", url: "u", ...over };
}

describe("classifySurface", () => {
  it("identifies a walkthrough by its heading", () => {
    expect(classifySurface(c({ body: "## Walkthrough\n\nThis PR adds..." }))).toBe("walkthrough");
  });

  it("identifies a review summary by the actionable-comments wrapper", () => {
    expect(classifySurface(c({ kind: "review", body: "**Actionable comments posted: 3**" }))).toBe("review-summary");
  });

  it("identifies any inline-kind comment as inline", () => {
    expect(classifySurface(c({ kind: "inline", body: "_:warning: Potential issue_", path: "a.ts", line: 4 }))).toBe("inline");
  });

  it("identifies a status comment by its review-status marker", () => {
    expect(classifySurface(c({ body: "<!-- coderabbit review status -->\nReviewing..." }))).toBe("status");
  });

  it("treats a bot reply that is none of the above as chat", () => {
    expect(classifySurface(c({ body: "@someone Good question — the reason is..." }))).toBe("chat");
  });

  it("classifies a human comment as other", () => {
    expect(classifySurface(c({ body: "lgtm", author: "octocat" }))).toBe("other");
  });
});
