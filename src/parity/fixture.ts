/**
 * Loader and validator for the parity fixture's PR series
 * (`tests/e2e/reference/2026-09/fixture-repo/pr-series/`). Each PR directory
 * holds a `pr.json` describing the PR and a `files/` tree of complete file
 * contents to copy over the fixture checkout — data, not a patch, so it
 * stays readable in review and needs no nested git repo.
 */
import fs from "node:fs";
import path from "node:path";

export type PrDef = {
  dir: string;
  title: string;
  body: string;
  base: string;
  branch: string;
  expects: string[];
};

export function loadPrSeries(root: string): PrDef[] {
  return fs
    .readdirSync(root)
    .filter((d) => /^\d\d-/.test(d))
    .sort()
    .map((d) => ({
      dir: d,
      ...(JSON.parse(fs.readFileSync(path.join(root, d, "pr.json"), "utf8")) as Omit<PrDef, "dir">),
    }));
}

/** Returns human-readable problems; an empty array means the series is valid. */
export function validatePrSeries(defs: PrDef[]): string[] {
  const problems: string[] = [];
  const branches = new Set<string>();
  for (const d of defs) {
    if (branches.has(d.branch)) problems.push(`${d.dir}: duplicate branch ${d.branch}`);
    branches.add(d.branch);
    if (!d.body.trim()) problems.push(`${d.dir}: empty body — the description pre-merge check needs a WHAT and a WHY`);
    if (d.expects.length === 0) problems.push(`${d.dir}: expects is empty — every PR must name the surface it provokes`);
    if (!d.title.trim()) problems.push(`${d.dir}: empty title`);
    else if (d.title.trim().endsWith(".")) problems.push(`${d.dir}: title ends in a period`);
    else if (d.title.length > 72) problems.push(`${d.dir}: title over 72 chars`);
  }
  return problems;
}
