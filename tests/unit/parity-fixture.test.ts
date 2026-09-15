import { describe, it, expect } from "vitest";
import { loadPrSeries, validatePrSeries, type PrDef } from "../../src/parity/fixture.js";
import { findPr } from "../../scripts/fixture-open-pr.js";

function def(over: Partial<PrDef> = {}): PrDef {
  return { dir: "01-a", title: "feat: a", body: "why", base: "main", branch: "feat/a", expects: ["walkthrough"], ...over };
}

const REAL_PR_SERIES_ROOT = "tests/e2e/reference/2026-09/fixture-repo/pr-series";

describe("validatePrSeries", () => {
  it("accepts a well-formed series", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b", branch: "fix/b" })])).toEqual([]);
  });

  it("rejects a duplicate branch name", () => {
    expect(validatePrSeries([def(), def({ dir: "02-b" })]).join()).toMatch(/duplicate branch/i);
  });

  it("rejects an empty body, which would trip the description pre-merge check", () => {
    expect(validatePrSeries([def({ body: "" })]).join()).toMatch(/body/i);
  });

  it("rejects a PR that declares no expected surface", () => {
    expect(validatePrSeries([def({ expects: [] })]).join()).toMatch(/expects/i);
  });

  it("rejects a title ending in a period, which the repo's title check warns on", () => {
    expect(validatePrSeries([def({ title: "feat: a." })]).join()).toMatch(/title/i);
  });
});

describe("the real pr-series fixture", () => {
  it("loads exactly ten entries and passes validation", () => {
    const defs = loadPrSeries(REAL_PR_SERIES_ROOT);
    expect(defs).toHaveLength(10);
    expect(validatePrSeries(defs)).toEqual([]);
  });

  it("marks PR 10 as not openable, since it records a follow-up action on PR 1 rather than a new PR", () => {
    const defs = loadPrSeries(REAL_PR_SERIES_ROOT);
    const ten = defs.find((d) => d.dir.startsWith("10-"));
    expect(ten?.open).toBe(false);
  });

  it("refuses to open PR 10 via findPr", () => {
    expect(() => findPr(REAL_PR_SERIES_ROOT, "10")).toThrow(/not meant to be opened|trial-runbook/i);
  });

  it("still finds an openable PR via findPr", () => {
    expect(findPr(REAL_PR_SERIES_ROOT, "01").dir).toBe("01-report-tags-search-export");
  });
});
