import { describe, it, expect } from "vitest";
import {
  renderRiskVerdict,
  renderRiskFactors,
  RISK_VERDICT_START,
  RISK_VERDICT_END,
  type RiskAssessment,
} from "../../src/insights.js";

function risk(partial: Partial<RiskAssessment> = {}): RiskAssessment {
  return { score: 0, level: "low", factors: [], ...partial };
}

/** The verdict line is the one CodeRabbit puts at top level, 15/15:
 *  `**Merge Risk:** _🟠 High_ · up to \`50f8b\``
 *  (tests/e2e/reference/2026-09/coderabbit/walkthrough.md:114). */
function verdictLine(block: string): string {
  return block.split("\n")[1];
}

describe("risk verdict above the fold", () => {
  it("renders the verdict, the score and the covered commit on one line", () => {
    const block = renderRiskVerdict(
      risk({ score: 62, level: "high", factors: [{ label: "Critical findings", weight: 40, detail: "2 critical issues flagged" }] }),
      "50f8b2e45b4d38b42ff0868c82e7a293977c7b62",
    );
    expect(verdictLine(block)).toBe("**Merge Risk:** _🔴 High_ · 62/100 · up to `50f8b2e`");
  });

  it("omits the commit clause when no head SHA is known", () => {
    const block = renderRiskVerdict(risk({ score: 5, level: "low" }));
    expect(verdictLine(block)).toBe("**Merge Risk:** _🟢 Low_ · 5/100");
    expect(block).not.toContain("up to");
  });

  it("carries a rationale naming the heaviest factors", () => {
    const block = renderRiskVerdict(
      risk({
        score: 55,
        level: "high",
        factors: [
          { label: "Major findings", weight: 10, detail: "2 major issues flagged" },
          { label: "Critical findings", weight: 20, detail: "1 critical issue flagged" },
          { label: "No new tests", weight: 10, detail: "Production code added/changed without accompanying tests" },
          { label: "Moderate change", weight: 5, detail: "262 lines changed across 5 files" },
        ],
      }),
    );
    expect(block).toContain(
      "Driven by Critical findings (+20), Major findings (+10) and No new tests (+10); 1 more factor below.",
    );
  });

  it("says so plainly when nothing is elevated", () => {
    const block = renderRiskVerdict(risk());
    expect(block).toContain("No elevated risk signals detected.");
    expect(block).not.toContain("Driven by");
  });

  it("sits between findable markers and inside no collapse", () => {
    const block = renderRiskVerdict(risk({ score: 20, level: "moderate" }), "abcdef1234567");
    expect(block.startsWith(RISK_VERDICT_START)).toBe(true);
    expect(block.trimEnd().endsWith(RISK_VERDICT_END)).toBe(true);
    expect(block).not.toContain("<details>");
    expect(block).not.toContain("<summary>");
  });

  it("renders each level with its own badge", () => {
    const badges: Array<[RiskAssessment["level"], string]> = [
      ["low", "🟢 Low"],
      ["moderate", "🟡 Moderate"],
      ["elevated", "🟠 Elevated"],
      ["high", "🔴 High"],
      ["critical", "🚨 Critical"],
    ];
    for (const [level, badge] of badges) {
      expect(verdictLine(renderRiskVerdict(risk({ level })))).toContain(`_${badge}_`);
    }
  });
});

describe("risk factors inside the collapse", () => {
  it("keeps the scored factor table, under a bold label rather than a heading", () => {
    const block = renderRiskFactors(
      risk({ score: 5, level: "low", factors: [{ label: "Moderate change", weight: 5, detail: "262 lines changed across 5 files" }] }),
    );
    expect(block).toContain("**Risk factors** — 5/100, 🟢 Low");
    expect(block).toContain("| Moderate change | +5 | 262 lines changed across 5 files |");
    expect(block).not.toContain("## ");
  });

  it("renders nothing when the verdict already said there is nothing to break down", () => {
    expect(renderRiskFactors(risk())).toBe("");
  });
});
