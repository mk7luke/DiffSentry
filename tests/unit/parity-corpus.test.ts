import { describe, it, expect } from "vitest";
import { classifySurface, selectForSpread, type CapturedComment, type Candidate } from "../../src/parity/corpus.js";

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

function cand(repo: string, number: number, language: string | null): Candidate {
  return { repo, number, title: `pr ${number}`, language, updatedAt: "2026-09-01T00:00:00Z" };
}

describe("selectForSpread", () => {
  it("caps how many PRs any single repo contributes", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("a/a", 2, "TS"), cand("a/a", 3, "TS"), cand("b/b", 4, "Go")],
      { limit: 10, maxPerRepo: 2 },
    );
    expect(out.filter((c) => c.repo === "a/a")).toHaveLength(2);
    expect(out.map((c) => c.repo)).toContain("b/b");
  });

  it("prefers an unseen language over a second PR in a seen one", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("b/b", 2, "TS"), cand("c/c", 3, "Python")],
      { limit: 2, maxPerRepo: 1 },
    );
    expect(out.map((c) => c.language)).toEqual(["TS", "Python"]);
  });

  it("honours the overall limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(`r${i}/r`, i, `L${i}`));
    expect(selectForSpread(many, { limit: 5, maxPerRepo: 1 })).toHaveLength(5);
  });

  it("returns an empty array for no candidates", () => {
    expect(selectForSpread([], { limit: 5, maxPerRepo: 2 })).toEqual([]);
  });
});
