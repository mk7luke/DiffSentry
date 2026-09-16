import { describe, it, expect } from "vitest";
import { formatWalkthroughInner } from "../../src/walkthrough.js";
import { renderSuggestedReviewers, renderCombinedReviewers } from "../../src/blame-reviewers.js";
import {
  renderCoverageBlock,
  renderRiskFactors,
  renderSplitSuggestion,
  renderReviewerDeltaBlock,
  renderSeverityCalibrationBlock,
  renderConfidenceAggregate,
} from "../../src/insights.js";
import { renderDriftBlock, renderCommitCoachBlock, renderTitleCoachBlock, reviewPRTitle } from "../../src/drift.js";
import { formatIssuesForWalkthrough } from "../../src/issues.js";
import type { WalkthroughConfig, WalkthroughResult } from "../../src/types.js";

const CONFIG: WalkthroughConfig = {
  changed_files_summary: true,
  sequence_diagrams: true,
  estimate_effort: true,
  suggested_labels: true,
  suggested_reviewers: true,
  poem: true,
};

const FULL: WalkthroughResult = {
  summary: "Added a guard.",
  fileDescriptions: [],
  cohorts: [{ theme: "Correctness", label: "Guard", files: ["src/a.ts"], summary: "Guarded." }],
  changeType: "bug_fix",
  effortEstimate: 3,
  effortMinutes: 30,
  sequenceDiagrams: ["sequenceDiagram\n  A->>B: go"],
  suggestedLabels: ["bug"],
  suggestedReviewers: ["mk7luke"],
  poem: "🐇 A guard was added",
};

/** Every markdown ATX heading in a block, as `#`-prefix + text. */
function headings(md: string): string[] {
  return md.split("\n").filter((l) => /^#{1,6}\s/.test(l));
}

describe("walkthrough heading weight", () => {
  it("keeps `##` for Walkthrough alone", () => {
    const h = headings(formatWalkthroughInner(FULL, CONFIG));
    expect(h.filter((l) => l.startsWith("## "))).toEqual(["## Walkthrough"]);
  });

  it("uses `###` for Changes and Sequence Diagram(s)", () => {
    const h = headings(formatWalkthroughInner(FULL, CONFIG));
    expect(h).toEqual(["## Walkthrough", "### Changes", "### Sequence Diagram(s)"]);
  });

  it("renders every other walkthrough.ts section as a bold label", () => {
    const md = formatWalkthroughInner(FULL, CONFIG);
    expect(md).toContain("**Change:** Bug fix");
    expect(md).toContain("**Estimated code review effort:**");
    expect(md).toContain("**Suggested labels:** `bug`");
    expect(md).toContain("**Suggested reviewers:** @mk7luke");
    expect(md).toContain("**Poem**");
  });
});

describe("insight and drift blocks carry no headings", () => {
  const blocks: Array<[string, string]> = [
    [
      "coverage",
      renderCoverageBlock({
        productionFiles: 2, productionAdditions: 63, testFiles: 1, testAdditions: 159,
        flag: "ok", detail: "63 prod / 159 test lines added.",
      }),
    ],
    [
      "risk factors",
      renderRiskFactors({ score: 5, level: "low", factors: [{ label: "Moderate change", weight: 5, detail: "d" }] }),
    ],
    ["split", renderSplitSuggestion([{ label: "A", files: ["a"] }, { label: "B", files: ["b"] }])],
    ["reviewer delta", renderReviewerDeltaBlock([{ reviewer: "mk7luke", filesChanged: 1, paths: ["a.ts"] }])],
    [
      "calibration",
      renderSeverityCalibrationBlock({
        adjustments: [{ path: "a.ts", line: 1, title: "t", from: "minor", to: "major", reasons: ["r"] }],
        confidenceLowered: 0,
      }),
    ],
    [
      "confidence",
      renderConfidenceAggregate({
        summary: "", approval: "COMMENT",
        comments: [
          { path: "a.ts", line: 1, body: "b", confidence: "low" },
          { path: "a.ts", line: 2, body: "b", confidence: "high" },
        ],
      } as never),
    ],
    [
      "drift",
      renderDriftBlock([{ level: "info", summary: "s", details: "d", confidence: "high" } as never]),
    ],
    ["title coach", renderTitleCoachBlock("wip", reviewPRTitle("wip"))],
    [
      "linked issues",
      formatIssuesForWalkthrough([
        { number: 1, title: "t", state: "open", url: "https://example.test/1" } as never,
      ]),
    ],
    ["blame reviewers", renderSuggestedReviewers([{ login: "a", changedLinesAuthored: 3, filesAuthored: 1 } as never])],
    [
      "combined reviewers",
      renderCombinedReviewers([
        { login: "a", blameLines: 3, blameFiles: 1, ownedFiles: 1, isTeam: false, sources: ["blame", "owner"] },
      ]),
    ],
  ];

  for (const [name, md] of blocks) {
    it(`${name} opens with a bold label, not a heading`, () => {
      expect(md.length).toBeGreaterThan(0);
      expect(headings(md)).toEqual([]);
      expect(md.split("\n")[0].startsWith("**")).toBe(true);
    });
  }
});

describe("suggested reviewers is one bold line", () => {
  it("drops the heading, the methodology sentence and the bullets", () => {
    const md = renderCombinedReviewers([
      { login: "mk7luke", blameLines: 12, blameFiles: 2, ownedFiles: 1, isTeam: false, sources: ["blame", "owner"] },
      { login: "core", blameLines: 0, blameFiles: 0, ownedFiles: 3, isTeam: true, sources: ["owner"] },
    ]);
    expect(md.split("\n")).toHaveLength(1);
    expect(md).toBe(
      "**Suggested reviewers:** @mk7luke (`blame`+`owner`, 12 touched line(s), owns 1 file(s)), @core (team) (`owner`, owns 3 file(s))",
    );
    expect(md).not.toContain("Ranked by");
    expect(md).not.toContain("- @");
  });

  it("stays empty when there is nobody to suggest", () => {
    expect(renderCombinedReviewers([])).toBe("");
    expect(renderSuggestedReviewers([])).toBe("");
  });
});

describe("commit message coach", () => {
  it("opens with a bold label", () => {
    const md = renderCommitCoachBlock([
      { sha: "abc1234", shaShort: "abc1234", message: "wip", level: "weak", reasons: ["Too vague"] },
    ]);
    expect(headings(md)).toEqual([]);
    expect(md.startsWith("**")).toBe(true);
  });
});
