import { describe, it, expect } from "vitest";
import fs from "node:fs";

const ROOT = "tests/e2e/reference/2026-09/fixture-repo";

describe("fixture isolation", () => {
  it("keeps the fixture's dependencies out of this repo's manifest", () => {
    const fixture = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8"));
    const ours = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const mine = new Set([...Object.keys(ours.dependencies ?? {}), ...Object.keys(ours.devDependencies ?? {})]);
    for (const dep of Object.keys(fixture.dependencies ?? {})) {
      expect(mine.has(dep), `${dep} must not be a dependency of DiffSentry`).toBe(false);
    }
  });

  it("is excluded from DiffSentry's own review", () => {
    const cfg = fs.readFileSync(".diffsentry.yaml", "utf8");
    expect(cfg).toContain("!tests/e2e/reference/**");
  });

  it("never installed the fixture's dependencies", () => {
    expect(fs.existsSync(`${ROOT}/node_modules`)).toBe(false);
  });

  it("plants only a documented, non-functional credential", () => {
    const planted = fs.readFileSync(`${ROOT}/pr-series/README.md`, "utf8");
    expect(planted).toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
