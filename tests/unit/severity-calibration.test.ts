import { describe, it, expect } from "vitest";
import {
  calibrateSeverities,
  resolveSeverityCalibration,
  wellTestedPaths,
  renderSeverityCalibrationBlock,
  DEFAULT_SEVERITY_CALIBRATION,
  assessCoverage,
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

const noTests = assessCoverage([file("src/foo.ts")]); // testAdditions === 0
const withTests = assessCoverage([file("src/foo.ts"), file("src/__tests__/foo.ts")]);

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

  it("matches __tests__/, test_*.py and *_test.go layouts", () => {
    expect(wellTestedPaths([file("pkg/auth.go"), file("pkg/auth_test.go")]).has("pkg/auth.go")).toBe(true);
    expect(wellTestedPaths([file("svc/api.py"), file("tests/test_api.py")]).has("svc/api.py")).toBe(true);
  });
});

describe("calibrateSeverities — escalation", () => {
  it("escalates a finding in a high-fan-in file", () => {
    const c = comment({ path: "src/foo.ts", severity: "minor" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
      fanInByFile: { "src/foo.ts": 9 },
      coverage: noTests,
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
      coverage: noTests,
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
      coverage: noTests,
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
      coverage: noTests,
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
      coverage: withTests,
      weights: DEFAULT_SEVERITY_CALIBRATION,
    });
    expect(c.severity).toBe<CommentSeverity>("minor");
    expect(c.confidence).toBe("medium");
    expect(res.confidenceLowered).toBe(1);
  });

  it("does NOT de-escalate when the PR added no tests (coverage gate)", () => {
    // Even if a same-stem file exists, gate on coverage.testAdditions > 0.
    const c = comment({ path: "src/foo.ts", severity: "major" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts")],
      coverage: noTests,
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("never softens deterministic security findings", () => {
    const c = comment({ path: "src/foo.ts", severity: "critical", type: "security" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts"), file("src/foo.test.ts")],
      coverage: withTests,
    });
    expect(c.severity).toBe<CommentSeverity>("critical");
  });

  it("never softens pattern/safety-engine findings (patternSource set)", () => {
    const c = comment({ path: "src/foo.ts", severity: "major", patternSource: "builtin" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/foo.ts"), file("src/foo.test.ts")],
      coverage: withTests,
    });
    expect(c.severity).toBe<CommentSeverity>("major");
  });

  it("net-zero (escalate + de-escalate cancel) leaves severity unchanged", () => {
    // high-risk path (+1) AND well-tested (−1) → net 0.
    const c = comment({ path: "src/auth/foo.ts", severity: "minor", type: "issue" });
    calibrateSeverities({
      comments: [c],
      files: [file("src/auth/foo.ts"), file("src/auth/foo.test.ts")],
      coverage: assessCoverage([file("src/auth/foo.ts"), file("src/auth/foo.test.ts")]),
    });
    expect(c.severity).toBe<CommentSeverity>("minor");
  });
});

describe("calibrateSeverities — guards", () => {
  it("is a no-op when disabled", () => {
    const c = comment({ path: "src/auth/x.ts", severity: "minor" });
    const res = calibrateSeverities({
      comments: [c],
      files: [file("src/auth/x.ts")],
      fanInByFile: { "src/auth/x.ts": 99 },
      coverage: noTests,
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
      coverage: noTests,
    });
    expect(c.severity).toBe<CommentSeverity>("major");
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
});
