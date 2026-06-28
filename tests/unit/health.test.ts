import { describe, it, expect } from "vitest";
// health.ts is pure (no imports) and shared by the web overview cards + RepoDetail
// header, so we exercise the scoring contract here at the repo's unit-test tier.
import { computeHealth, riskTrend } from "../../web/src/lib/health";

describe("computeHealth", () => {
  it("returns a neutral no-data verdict when there are no reviews", () => {
    const h = computeHealth({ prsReviewed: 0, approved: 0, changesRequested: 0, pending: 0, findings: 0, critical: 0 });
    expect(h.hasData).toBe(false);
    expect(h.grade).toBe("—");
    expect(h.tone).toBe("muted");
    expect(h.breakdown.total).toBe(0);
  });

  it("grades a clean, all-approved repo highly", () => {
    const h = computeHealth({ prsReviewed: 20, approved: 19, changesRequested: 1, pending: 0, findings: 1, critical: 0 });
    expect(h.hasData).toBe(true);
    expect(h.score).toBeGreaterThanOrEqual(90);
    expect(h.tone).toBe("good");
    expect(h.grade.startsWith("A")).toBe(true);
  });

  it("drops the grade and tone when criticals pile up", () => {
    const clean = computeHealth({ prsReviewed: 10, approved: 9, changesRequested: 1, pending: 0, findings: 2, critical: 0 });
    const risky = computeHealth({ prsReviewed: 10, approved: 3, changesRequested: 6, pending: 1, findings: 14, critical: 6 });
    expect(risky.score).toBeLessThan(clean.score);
    expect(risky.tone).toBe("danger");
  });

  it("exposes the approval split as the breakdown", () => {
    const h = computeHealth({ prsReviewed: 12, approved: 7, changesRequested: 3, pending: 2, findings: 4, critical: 1 });
    expect(h.breakdown).toEqual({ approved: 7, changesRequested: 3, pending: 2, total: 12 });
  });

  it("nudges the score down for a rising risk trend and up for a cooling one", () => {
    const base = { prsReviewed: 10, approved: 8, changesRequested: 2, pending: 0, findings: 3, critical: 0 };
    const rising = computeHealth({ ...base, riskTrend: 20 });
    const cooling = computeHealth({ ...base, riskTrend: -20 });
    expect(rising.score).toBeLessThan(cooling.score);
  });

  it("clamps the score into 0..100", () => {
    const worst = computeHealth({ prsReviewed: 1, approved: 0, changesRequested: 5, pending: 0, findings: 99, critical: 99, riskTrend: 100 });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});

describe("riskTrend", () => {
  it("returns null without enough points to compare", () => {
    expect(riskTrend([])).toBeNull();
    expect(riskTrend([42])).toBeNull();
    expect(riskTrend([null, undefined])).toBeNull();
  });

  it("is positive when recent scores exceed earlier ones", () => {
    expect(riskTrend([10, 10, 80, 80])).toBeGreaterThan(0);
  });

  it("is negative when recent scores fall below earlier ones", () => {
    expect(riskTrend([80, 80, 10, 10])).toBeLessThan(0);
  });

  it("ignores non-finite entries", () => {
    expect(riskTrend([10, null, 10, undefined, 90, 90])).toBeGreaterThan(0);
  });
});
