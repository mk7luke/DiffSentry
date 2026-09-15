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
  /** false for a series entry that records a follow-up action rather than a PR to open. Defaults to true. */
  open?: boolean;
  /**
   * Repo-relative paths this PR removes from its base. `files/` is an
   * overlay applied on top of the checkout (see copyFilesTree in
   * scripts/fixture-open-pr.ts) — a path a PR's scenario means to delete or
   * rename away has no way to say so just by being absent from `files/`,
   * since the base version simply survives untouched. List it here instead.
   */
  deletes?: string[];
};

/**
 * Maps a path from a PR's `files/` tree to the path it should land at in the
 * fixture checkout. A `.tmpl` suffix strips off here.
 *
 * Why this exists: `actions/dependency-review-action` flags any file named
 * `package.json` by path in a PR's diff, whether or not it's ever installed
 * (see PR 09, which plants a vulnerable `lodash` pin on purpose to provoke a
 * dependency-advisory finding). Naming the template `package.json.tmpl`
 * keeps GitHub's manifest detection from seeing it, while this function
 * still applies it to the fixture checkout as a real `package.json`. This is
 * a general rule, not special-cased to PR 09 — any future PR that plants
 * another manifest-named file gets the same treatment for free. Don't
 * "tidy away" the `.tmpl` suffix or the rename in PR 09's `files/` tree;
 * doing so re-breaks the dependency-review CI gate.
 */
export function applyTemplatePath(relPath: string): string {
  return relPath.endsWith(".tmpl") ? relPath.slice(0, -".tmpl".length) : relPath;
}

/**
 * Resolves `relPath` (a path from a PR's `files/` tree) against `destDir`,
 * throwing if `relPath` isn't a well-formed repo-relative path — the same
 * invariant `validatePrSeries` already enforces on a PR's `deletes` list,
 * applied here to every path `copyFilesTree` (in
 * `scripts/fixture-open-pr.ts`) is about to write to — or if the resolved
 * destination doesn't stay strictly inside `destDir`.
 *
 * The inside-`destDir` check resolves both sides with `path.resolve` and
 * does a separator-aware prefix comparison, not a bare string `startsWith`:
 * a naive `startsWith(destDir)` would wrongly accept a sibling directory
 * that merely shares `destDir` as a string prefix (`/tmp/foo-evil` "starts
 * with" `/tmp/foo`, but is not inside it).
 */
export function resolveCopyTarget(destDir: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    throw new Error(`fixture entry ${JSON.stringify(relPath)} must be a non-empty repo-relative path with no ".." segment`);
  }
  const resolvedDestDir = path.resolve(destDir);
  const resolved = path.resolve(resolvedDestDir, relPath);
  if (resolved !== resolvedDestDir && !resolved.startsWith(resolvedDestDir + path.sep)) {
    throw new Error(`fixture entry ${JSON.stringify(relPath)} resolves to ${resolved}, outside ${resolvedDestDir}`);
  }
  return resolved;
}

export function loadPrSeries(root: string): PrDef[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    // Directories only, and only those carrying a pr.json. Matching on the
    // `NN-` prefix alone would pull in a stray note file or an auxiliary
    // directory and then fail deep inside readFileSync with an ENOTDIR or
    // ENOENT naming a path the caller never asked for — a worse diagnostic
    // than simply not treating it as a PR definition.
    .filter((e) => e.isDirectory() && /^\d\d-/.test(e.name))
    .map((e) => e.name)
    .filter((d) => fs.existsSync(path.join(root, d, "pr.json")))
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
    for (const del of d.deletes ?? []) {
      if (!del || path.isAbsolute(del) || del.split(/[\\/]/).includes("..")) {
        problems.push(`${d.dir}: deletes entry ${JSON.stringify(del)} must be a non-empty repo-relative path with no ".." segment`);
      }
    }
  }
  return problems;
}
