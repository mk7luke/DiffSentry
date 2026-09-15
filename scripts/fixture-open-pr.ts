/**
 * Open one PR from the parity fixture's ten-PR series
 * (`tests/e2e/reference/2026-09/fixture-repo/pr-series/`) against the
 * operator's throwaway public fixture repo (see
 * `docs/parity/trial-runbook.md`). One PR per invocation, deliberately:
 * Phase D captures each bot's response before the next PR lands, and PR 08
 * (the merge-conflict case) must not be opened until PR 01 has MERGED —
 * that ordering is a human/runbook responsibility, not something this
 * script can verify on its own, so follow the runbook's capture order.
 *
 *   npm run fixture:open -- --repo <owner/name> --pr 01
 *
 * SAFETY: refuses to run unless --repo is explicitly given and is not
 * DiffSentry's own repository — see assertSafeTarget(). This is the only
 * thing standing between this script and pushing branches into the real
 * DiffSentry repo, so it is checked first, before any git/gh call.
 *
 * Mechanics: maintains a local clone of --repo under the OS temp dir
 * (override with --dir), separate from this checkout, so this script never
 * touches DiffSentry's own working tree. Each run fetches origin, refuses
 * to proceed if that clone's tree is dirty (see ensureCleanCheckout), syncs
 * `base` to `origin/<base>`, branches, `git rm`s any paths the PR's
 * `deletes` list names, copies `files/` over the clone (stripping any
 * `.tmpl` suffix off copied filenames — see `applyTemplatePath` in
 * `src/parity/fixture.ts` for why), commits with the PR title, pushes, and
 * opens the PR via `gh pr create`.
 * If anything fails after branching, it best-effort checks the clone back
 * out to `base` so a failed run doesn't leave the clone parked on a
 * half-finished branch for the next invocation to trip over.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTemplatePath, loadPrSeries, resolveCopyTarget, validatePrSeries, type PrDef } from "../src/parity/fixture.js";

const DEFAULT_ROOT = "tests/e2e/reference/2026-09/fixture-repo/pr-series";

// DiffSentry's own repo — this script must never be able to push here.
// Checked case-insensitively; also see the independent "own origin" check
// in assertSafeTarget, which catches a rename/fork of this same repo.
const FORBIDDEN_REPOS = new Set(["mk7luke/diffsentry"]);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function run(cmd: string, args: string[], opts: { cwd?: string; silent?: boolean } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.silent ? "pipe" : "inherit"],
  }).trim();
}

function originRepoSlug(): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const m = url.match(/[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Throws unless `repo` is safe to open PRs against. Runs before any git/gh call. */
function assertSafeTarget(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`--repo must be "owner/name" (got ${JSON.stringify(repo)})`);
  }
  if (FORBIDDEN_REPOS.has(repo.toLowerCase())) {
    throw new Error(
      `Refusing to target ${repo} — that is DiffSentry's own repository. ` +
        `fixture:open only ever targets the throwaway public fixture repo you created per ` +
        `docs/parity/trial-runbook.md step 1, never this one.`,
    );
  }
  const origin = originRepoSlug();
  if (origin && origin.toLowerCase() === repo.toLowerCase()) {
    throw new Error(`Refusing to target ${repo} — it is this checkout's own "origin" remote.`);
  }
}

export function findPr(root: string, pr: string): PrDef {
  const defs = loadPrSeries(root);
  const problems = validatePrSeries(defs);
  if (problems.length) throw new Error(`pr-series at ${root} is invalid:\n${problems.join("\n")}`);
  const def = defs.find((d) => d.dir.startsWith(`${pr}-`));
  if (!def) throw new Error(`no PR ${pr} under ${root} (have: ${defs.map((d) => d.dir).join(", ")})`);
  if (def.open === false) {
    throw new Error(
      `PR ${pr} (${def.dir}) is not meant to be opened as a PR — it records a follow-up action against ` +
        `an already-open PR instead. See docs/parity/trial-runbook.md for how to run it.`,
    );
  }
  return def;
}

/** Clones `repo` into `dir` if absent; otherwise fetches and refuses if the tree is dirty. */
function ensureCleanCheckout(dir: string, repo: string): void {
  if (!fs.existsSync(dir)) {
    console.log(`Cloning ${repo} into ${dir} ...`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run("gh", ["repo", "clone", repo, dir]);
    return;
  }
  const originUrl = run("git", ["remote", "get-url", "origin"], { cwd: dir, silent: true });
  if (!originUrl.toLowerCase().includes(repo.toLowerCase())) {
    throw new Error(`${dir} already exists but its origin (${originUrl}) doesn't match --repo ${repo}. Remove it or pass a different --dir.`);
  }
  run("git", ["fetch", "origin"], { cwd: dir });
  const status = run("git", ["status", "--porcelain"], { cwd: dir, silent: true });
  if (status) {
    throw new Error(`${dir} has a dirty working tree — refusing to mutate it. Clean it up (or delete ${dir}) and re-run.`);
  }
}

function remoteBranchExists(dir: string, branch: string): boolean {
  return run("git", ["ls-remote", "--heads", "origin", branch], { cwd: dir, silent: true }).length > 0;
}

/**
 * Copies `srcDir` over `destDir`, applying `applyTemplatePath` to every
 * copied file's relative path so a `.tmpl`-suffixed template (see
 * `src/parity/fixture.ts`) lands in the fixture checkout under its real
 * name. Walks the tree itself (rather than `fs.cpSync`'s built-in
 * recursion) because `cpSync` has no per-file rename hook.
 *
 * Every destination this function writes to is bounds-checked with
 * `resolveCopyTarget` against `destDir` (the root passed in by the caller —
 * `destDir` here is always that fixed root, tracked across recursive calls
 * via `relPrefix`, never a moving target), matching the same
 * no-absolute/no-`..` invariant `validatePrSeries` enforces on a PR's
 * `deletes` list. Without it, a `files/` tree entry — committed to this
 * repo, or supplied via a user-controlled `--root` pointed at an untrusted
 * pr-series — could otherwise write outside the fixture clone.
 *
 * The bounds check runs *after* `applyTemplatePath` strips a trailing
 * `.tmpl`, not before: what actually needs to stay inside `destDir` is the
 * path this function is about to write to, and that's the post-strip path.
 * Stripping never introduces or removes a `..` segment (it only trims a
 * fixed suffix off the final path segment), so the two orders agree on
 * every input here; post-strip is chosen because it validates the real
 * write target rather than an intermediate name that's never touched on
 * disk.
 *
 * Refuses any symlink encountered in the tree, rather than following it.
 * `entry.isDirectory()`/`isFile()` are false for a symlink dirent (Node
 * reports the entry's own type, not its target's), so a symlinked
 * directory would already fail to recurse and a symlinked file would fall
 * into the file branch — where `copyFileSync` follows it and copies
 * whatever it points to. The destination stays inside `destDir` either
 * way (dest is always built from `destDir` + this tree's own relative
 * path, never from the symlink's target), so this isn't a write-outside-
 * destDir vector — but a symlink can still point at an arbitrary file
 * outside the fixture tree (e.g. `~/.ssh/id_rsa`) whose *contents* would
 * then be copied in, committed, and pushed to the (public) fixture repo.
 * Refusing symlinks outright avoids that disclosure.
 */
function copyFilesTree(srcDir: string, destDir: string, relPrefix = ""): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = path.join(relPrefix, entry.name);
    const src = path.join(srcDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`fixture entry ${JSON.stringify(relPath)} is a symlink — refusing to copy it`);
    }
    if (entry.isDirectory()) {
      resolveCopyTarget(destDir, relPath);
      copyFilesTree(src, destDir, relPath);
      continue;
    }
    const dest = resolveCopyTarget(destDir, applyTemplatePath(relPath));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main(): void {
  const repo = arg("repo");
  const pr = arg("pr");
  const root = arg("root", DEFAULT_ROOT);
  const dir = arg("dir", path.join(os.tmpdir(), `diffsentry-fixture-${repo.replace("/", "-")}`));

  assertSafeTarget(repo);

  const def = findPr(root, pr);

  ensureCleanCheckout(dir, repo);

  if (remoteBranchExists(dir, def.branch)) {
    throw new Error(`origin/${def.branch} already exists on ${repo} — PR ${pr} looks already opened. Nothing to do.`);
  }

  console.log(`Opening PR ${pr} (${def.dir}) against ${repo}: ${def.branch} -> ${def.base}`);

  try {
    run("git", ["fetch", "origin", def.base], { cwd: dir });
    run("git", ["checkout", "-B", def.base, `origin/${def.base}`], { cwd: dir });
    run("git", ["checkout", "-b", def.branch], { cwd: dir });

    // Apply declared deletions before copying files/: `files/` is an
    // overlay (see copyFilesTree), so a path a PR means to remove or rename
    // away has no way to say so just by being absent from files/ — the base
    // version would otherwise survive untouched. Deleting first, then
    // overlaying, means a path that is both deleted and re-added (a rename
    // to a new location with the same leaf name, say) still lands correctly.
    for (const del of def.deletes ?? []) {
      run("git", ["rm", "-f", del], { cwd: dir });
    }

    const filesDir = path.join(root, def.dir, "files");
    copyFilesTree(filesDir, dir);

    run("git", ["add", "-A"], { cwd: dir });
    run("git", ["commit", "-m", def.title], { cwd: dir });
    run("git", ["push", "-u", "origin", def.branch], { cwd: dir });

    const url = run("gh", [
      "pr", "create",
      "--repo", repo,
      "--base", def.base,
      "--head", def.branch,
      "--title", def.title,
      "--body", def.body,
    ], { cwd: dir });

    run("git", ["checkout", def.base], { cwd: dir });
    console.log(url);
  } catch (err) {
    // Don't leave the clone parked on a half-finished branch for the next
    // invocation's clean-tree check to trip over.
    try {
      run("git", ["checkout", def.base], { cwd: dir, silent: true });
    } catch {
      // best-effort only
    }
    throw err;
  }
}

if (require.main === module) {
  main();
}
