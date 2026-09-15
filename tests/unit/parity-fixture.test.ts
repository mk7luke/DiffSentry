import { describe, it, expect } from "vitest";
import { validatePrSeries, type PrDef } from "../../src/parity/fixture.js";

function def(over: Partial<PrDef> = {}): PrDef {
  return { dir: "01-a", title: "feat: a", body: "why", base: "main", branch: "feat/a", expects: ["walkthrough"], ...over };
}

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
