import { describe, it, expect } from "vitest";
import { formatWalkthroughInner } from "../../src/walkthrough.js";
import { parseWalkthroughResponse } from "../../src/ai/parse.js";
import type { WalkthroughResult, WalkthroughConfig } from "../../src/types.js";

const CONFIG: WalkthroughConfig = {
  changed_files_summary: true,
  sequence_diagrams: true,
  estimate_effort: true,
  suggested_labels: true,
  suggested_reviewers: true,
};

function result(partial: Partial<WalkthroughResult> = {}): WalkthroughResult {
  return {
    summary: "Added a guard around the nullable branch.",
    fileDescriptions: [],
    cohorts: [{ label: "Guard", files: ["src/a.ts"], summary: "Guarded." }],
    effortEstimate: 3,
    effortMinutes: 30,
    ...partial,
  };
}

describe("walkthrough **Change:** axis", () => {
  it("renders each value in the corpus's sentence case, with no glyph", () => {
    const cases = {
      bug_fix: "**Change:** Bug fix",
      feature: "**Change:** Feature",
      other: "**Change:** Other",
    } as const;
    for (const [value, rendered] of Object.entries(cases)) {
      const md = formatWalkthroughInner(result({ changeType: value as never }), CONFIG);
      expect(md).toContain(rendered);
    }
  });

  it("pairs with the effort line, both as bold labels rather than headings", () => {
    const md = formatWalkthroughInner(result({ changeType: "feature" }), CONFIG);
    expect(md).toContain("**Change:** Feature\n\n**Estimated code review effort:** 🎯 3 (Moderate) | ⏱️ ~30 minutes");
    expect(md).not.toContain("## Estimated code review effort");
  });

  // Degradation, mirroring the inline-header contract Wave 1 established: a
  // model that never learned about the field must still produce a walkthrough.
  it("renders a valid walkthrough when the model omits the field entirely", () => {
    const md = formatWalkthroughInner(result(), CONFIG);
    expect(md).not.toContain("**Change:**");
    expect(md).not.toContain("undefined");
    expect(md).toContain("## Walkthrough");
    expect(md).toContain("**Estimated code review effort:**");
  });

  it("drops a value outside the enum rather than rendering it", () => {
    const parsed = parseWalkthroughResponse(
      JSON.stringify({ summary: "s", fileDescriptions: [], changeType: "refactor" }),
    );
    expect(parsed.changeType).toBeUndefined();
    const md = formatWalkthroughInner({ ...result(), changeType: parsed.changeType }, CONFIG);
    expect(md).not.toContain("**Change:**");
    expect(md).not.toContain("undefined");
  });

  it("round-trips a valid value through the parser", () => {
    const parsed = parseWalkthroughResponse(
      JSON.stringify({ summary: "s", fileDescriptions: [], changeType: "bug_fix" }),
    );
    expect(parsed.changeType).toBe("bug_fix");
  });

  it("carries no **Priority:** axis — the merge-risk verdict is the only verdict", () => {
    const md = formatWalkthroughInner(result({ changeType: "bug_fix" }), CONFIG);
    expect(md).not.toContain("**Priority:**");
  });
});
