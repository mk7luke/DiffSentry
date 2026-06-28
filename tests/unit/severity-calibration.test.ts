import { describe, it, expect } from "vitest";
import {
  calibrateSeverities,
  resolveSeverityCalibration,
  wellTestedPaths,
  renderSeverityCalibrationBlock,
  DEFAULT_SEVERITY_CALIBRATION,
} from "../../src/insights.js";
import type { CommentSeverity, FileChange, ReviewComment } from "../../src/types.js";

function file(filename: string, additions = 20, status: FileChange["status"] = "modified"): FileChange {
  return { filename, status, patch: "@@ -1 +1 @@\n+x", additions, deletions: 0 };
}

function comment(over: Partial<ReviewComment>): ReviewComment {
  return {
    path: "src/foo.ts",
    line: 10,
    side: "RIGHT",
    body: "b",
    severity: "minor",
    type: "issue",
    confidence: "high",
    ...over,
  };
}

describe("resolveSeverityCalibration", () => {
  it("returns defaults when no config given", () => {
    expect(resolveSeverityCalibration(undefined)).toEqual(DEFAULT_SEVERITY_CALIBRATION);
  });

  it("overrides per-field and ignores invalid numerics", () => {
    const r = resolveSeverityCalibration({
      escalate_high_fan_in: 2,
      high_fan_in_threshold: -3 as unknown as number, // invalid → falls back
      max_escalation: 3,
    });
    expect(r.escalateHighFanIn).toBe(2);
    expect(r.highFanInThreshold).toBe(DEFAULT_SEVERITY_CALIBRATION.highFanInThreshold);
    expect(r.maxEscalation).toBe(3);
  });
});

describe("wellTestedPaths", () => {
  it("pairs a production file with a sibling test changed in the same PR", () => {
    const paths = wellTestedPaths([
      file("src/limiter.ts"),
      file("src/limiter.test.ts"),
      file("src/untested.ts"),
    ]);
    expect(paths.has("src/limiter.ts")).toBe(true);
    expect(paths.has("src/untested.ts")).toBe(false);
  });

  it("matches same-directory test_*.py and *_test.go layouts", () => {
    expect(wellTestedPaths([file("pkg/auth.go"), file("pkg/auth_test.go")]).has("pkg/auth.go")).toBe(true);
    expect(wellTestedPaths([file("svc/api.py"), file("svc/test_api.py")]).has("svc/api.py")).toBe(true);
  });

  it("matches __tests__/ subfolders and mirrored tests/ trees", () => {
    expect(
      wellTestedPaths([file("src/components/Btn.ts"), file("src/components/__tests__/Btn.test.ts")]).has(
        "src/components/Btn.ts",
      ),
    ).toBe(true);
    // mirrored tree: tests/api/… covers src/api/…
    expect(wellTestedPaths([file("src/api/foo.ts"), file("tests/api/foo.test.ts")]).has("src/api/foo.ts")).toBe(true);
  });

  it("matches a nested mirrored tree where the source root sits below a package dir", () => {
    // packages/api/src/foo.ts ↔ tests/packages/api/foo.test.ts (src nested at end)
    expect(
      wellTestedPaths([file("packages/api/src/foo.ts"), file("tests/packages/api/foo.test.ts")]).has(
        "packages/api/src/foo.ts",
      ),
    ).toBe(true);
    // …but a flat top-level test must NOT pair with a nested source.
    expect(
      wellTestedPaths([file("packages/api/src/foo.ts"), file("tests/foo.test.ts")]).has("packages/api/src/foo.ts"),
    ).toBe(false);
    // …nor a shallower mirrored path: tests/api/… mirrors api/… (or src/api/…),
    // NOT the deeper packages/api/src/… — the package prefix must be preserved.
    expect(
      wellTestedPaths([file("packages/api/src/foo.ts"), file("tests/api/foo.test.ts")]).has("packages/api/src/foo.ts"),
    ).toBe(false);
  });

  it("does NOT pair same-stem files in unrelated directories (directory scoping)", () => {
    // Regression: a global basename index would wrongly pair these. They share
    // the stem `foo` but live in sibling packages, so neither is well-tested.
    const paths = wellTestedPaths([file("packages/api/foo.ts"), file("packages/web/foo.test.ts")]);
    expect(paths.has("packages/api/foo.ts")).toBe(false);
    expect(paths.size).toBe(0);
  });
});

describe("calibrateSeverities — escalation", () => {
  it("escalates a finding in a high-fan-in file", () => {
    const c = comment({ path: "src/foo.ts", severity: "minor" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
      fanInByFile: { "src/foo.ts": 9 },
      weights: DEFAULT_SEVERITY_CALIBRATION,
    });
    expect(c.severity).toBe<CommentSeverity>("major");
    expect(res.adjustments[0].reasons.join()).toContain("high fan-in");
  });

  it("escalates a finding in a high-risk path (auth/)", () => {
    const c = comment({ path: "src/auth/session.ts", severity: "minor" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/auth/session.ts")],
      weights: DEFAULT_SEVERITY_CALIBRATION,
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("stacks both signals but caps at max_escalation", () => {
    const c = comment({ path: "payment/charge.ts", severity: "minor" });
    calibrateSeverities({
      comments: [c],
      files: [file("payment/charge.ts")],
      fanInByFile: { "payment/charge.ts": 12 },
      weights: { ...DEFAULT_SEVERITY_CALIBRATION, maxEscalation: 2 },
    });
    // minor(1) + 2 steps → critical(3)
    expect(c.severity).toBe<CommentSeverity>("critical");
  });

  it("never escalates beyond critical", () => {
    const c = comment({ path: "src/auth/x.ts", severity: "critical" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/auth/x.ts")],
      fanInByFile: { "src/auth/x.ts": 50 },
    });
    expect(c.severity).toBe<CommentSeverity>("critical");
  });
});

describe("calibrateSeverities — de-escalation", () => {
  it("de-escalates and lowers confidence in a well-tested path", () => {
    const c = comment({ path: "src/foo.ts", severity: "major", confidence: "high", type: "issue" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts"), file("src/foo.test.ts")],
      weights: DEFAULT_SEVERITY_CALIBRATION,
    });
    expect(c.severity).toBe<CommentSeverity>("minor");
    expect(c.confidence).toBe("medium");
    expect(res.confidenceLowered).toBe(1);
  });

  it("does NOT de-escalate when no sibling test changed for the path", () => {
    const c = comment({ path: "src/foo.ts", severity: "major" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("does NOT de-escalate a finding whose only same-stem test is in an unrelated dir", () => {
    const c = comment({ path: "packages/api/foo.ts", severity: "major", type: "issue" });
    calibrateSeverities({
      comments: [c],
      files: [file("packages/api/foo.ts"), file("packages/web/foo.test.ts")],
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("never softens deterministic security findings", () => {
    const c = comment({ path: "src/foo.ts", severity: "critical", type: "security" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts"), file("src/foo.test.ts")],
    });
    expect(c.severity).toBe<CommentSeverity>("critical");
  });

  it("never softens pattern/safety-engine findings (patternSource set)", () => {
    const c = comment({ path: "src/foo.ts", severity: "major", patternSource: "builtin" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts"), file("src/foo.test.ts")],
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("net-zero (escalate + de-escalate cancel) leaves severity AND confidence unchanged", () => {
    // high-risk path (+1) AND well-tested (−1) → net 0: nothing was softened, so
    // confidence must NOT drop just because a sibling test exists.
    const c = comment({ path: "src/auth/foo.ts", severity: "minor", type: "issue", confidence: "high" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/auth/foo.ts"), file("src/auth/foo.test.ts")],
    });
    expect(c.severity).toBe<CommentSeverity>("minor");
    expect(c.confidence).toBe("high");
    expect(res.confidenceLowered).toBe(0);
  });

  it("does not lower confidence when escalation outweighs well-tested softening", () => {
    // high fan-in (+1) and high-risk (+1) capped vs well-tested (−1) → net up.
    const c = comment({ path: "payment/foo.ts", severity: "minor", type: "issue", confidence: "high" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("payment/foo.ts"), file("payment/foo.test.ts")],
      fanInByFile: { "payment/foo.ts": 10 },
    });
    expect(c.severity).toBe<CommentSeverity>("major");
    expect(c.confidence).toBe("high");
    expect(res.confidenceLowered).toBe(0);
  });
});

describe("calibrateSeverities — guards", () => {
  it("is a no-op when disabled", () => {
    const c = comment({ path: "src/auth/x.ts", severity: "minor" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/auth/x.ts")],
      fanInByFile: { "src/auth/x.ts": 99 },
      weights: { ...DEFAULT_SEVERITY_CALIBRATION, enabled: false },
    });
    expect(c.severity).toBe<CommentSeverity>("minor");
    expect(res.adjustments).toHaveLength(0);
  });

  it("matches fan-in keys regardless of ./ prefix normalisation", () => {
    const c = comment({ path: "src/foo.ts", severity: "minor" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
      fanInByFile: { "./src/foo.ts": 8 },
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });
});

describe("calibrateSeverities — mutation contract", () => {
  it("only changes severity/confidence and preserves the rest of the payload", () => {
    const c: ReviewComment = {
      path: "src/foo.ts",
      line: 123,
      side: "RIGHT",
      body: "distinctive body text",
      type: "issue",
      severity: "minor",
      title: "A distinctive title",
      suggestion: "do the thing",
      suggestionLanguage: "diff",
      aiAgentPrompt: "prompt",
      fingerprint: "fp-distinctive",
      confidence: "high",
      patternSource: undefined,
      customRuleId: undefined,
    };
    const before = { ...c };
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
      fanInByFile: { "src/foo.ts": 9 }, // high fan-in → escalate minor→major
    });
    // intended mutations
    expect(c.severity).toBe<CommentSeverity>("major");
    // confidence unchanged (escalation, not softening)
    expect(c.confidence).toBe("high");
    // everything else preserved
    expect(c.path).toBe(before.path);
    expect(c.line).toBe(before.line);
    expect(c.side).toBe(before.side);
    expect(c.body).toBe(before.body);
    expect(c.type).toBe(before.type);
    expect(c.title).toBe(before.title);
    expect(c.suggestion).toBe(before.suggestion);
    expect(c.suggestionLanguage).toBe(before.suggestionLanguage);
    expect(c.aiAgentPrompt).toBe(before.aiAgentPrompt);
    expect(c.fingerprint).toBe(before.fingerprint);
    expect(c.patternSource).toBe(before.patternSource);
    expect(c.customRuleId).toBe(before.customRuleId);
  });
});

describe("renderSeverityCalibrationBlock", () => {
  it("returns empty string when nothing changed", () => {
    expect(renderSeverityCalibrationBlock({ adjustments: [], confidenceLowered: 0 })).toBe("");
  });

  it("renders a table with direction arrows", () => {
    const md = renderSeverityCalibrationBlock({
      adjustments: [{ path: "src/auth/x.ts", line: 3, title: "Race", from: "minor", to: "major", reasons: ["high-risk path"] }],
      confidenceLowered: 0,
    });
    expect(md).toContain("Severity calibration");
    expect(md).toContain("⬆️");
    expect(md).toContain("minor → major");
  });

  it("renders a confidence-only summary when no severity changed", () => {
    const md = renderSeverityCalibrationBlock({ adjustments: [], confidenceLowered: 2 });
    expect(md).toContain("Severity calibration");
    expect(md).toContain("Confidence was lowered for 2 well-tested findings");
    expect(md).not.toContain("| Finding |");
  });
});
