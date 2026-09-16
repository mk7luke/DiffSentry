import { Octokit } from "@octokit/rest";
import { randomUUID } from "node:crypto";
import { PRContext } from "./types.js";
import { logger } from "./logger.js";

/**
 * Stacked-PR delivery for the finishing touches.
 *
 * CodeRabbit offers every finishing touch two destinations — `Create stacked
 * PR` and `Commit on current branch` (corpus:
 * `tests/e2e/reference/2026-09/coderabbit/walkthrough.md:164`). DiffSentry only
 * ever had the second: `src/finishing-touches.ts` writes through the Contents
 * API straight onto `context.headBranch`.
 *
 * "Stacked" is the load-bearing word. The new PR's **base is the reviewed PR's
 * head branch**, not the repo's default branch — so it sits on top of the work
 * under review and merges into it, rather than racing it. A PR based on
 * `defaultBranch` would be a parallel PR and would show the reviewed PR's own
 * diff as part of its changes.
 *
 * Nothing here needs a sandbox. It is the same `repos.createOrUpdateFileContents`
 * call the branch path already makes, aimed at a fresh ref, plus one
 * `git.createRef` before it and one `pulls.create` after it.
 *
 * ## Failure is always reported
 *
 * Every function here returns a result rather than throwing, and every failure
 * carries the stage it happened at and a human-readable reason. The defect this
 * module exists to close was a checkbox that did nothing *and said nothing*;
 * a stacked delivery that fails silently would be the same bug with more code
 * behind it. Callers must render {@link StackedPrOutcome.error}.
 */

/** Where a finishing touch puts its edits. */
export type Delivery = "branch" | "stacked";

/** One file the model wants rewritten in full. */
export interface FileEdit {
  path: string;
  content: string;
}

/** A file we could not write, and why. Surfaced to the PR, never swallowed. */
export interface WriteFailure {
  path: string;
  message: string;
}

/** The PR a successful stacked delivery opened. */
export interface StackedPrRef {
  branch: string;
  number: number;
  url: string;
  base: string;
}

export interface StackedPrOutcome {
  filesChanged: number;
  /** Last commit written, for the branch path's `Commit: <sha>` receipt. */
  commitSha?: string;
  /** Per-file write failures. Empty on a clean run. */
  failures: WriteFailure[];
  /** Set when a stacked delivery opened a PR. */
  stacked?: StackedPrRef;
  /**
   * Set when the delivery failed as a whole — the branch could not be cut, no
   * file could be written, or `pulls.create` was refused. Callers render this
   * verbatim on the PR.
   */
  error?: string;
  /**
   * A branch that exists and holds the edits although no PR was opened for it.
   * Named in the failure message so the work is recoverable by hand.
   */
  orphanBranch?: string;
}

/**
 * Branch name for a stacked delivery.
 *
 * `diffsentry/<touch>/pr-<number>-<head sha, 7>-<6 random hex>`
 *
 * Each segment earns its place:
 *  - `diffsentry/` namespaces every branch this bot creates, so an operator can
 *    see and delete them as a group;
 *  - `<touch>` says which finishing touch produced it;
 *  - `pr-<number>` keeps two concurrently-reviewed PRs from colliding;
 *  - the head sha says which commit it was stacked on, which is the one fact
 *    you need when two stacked PRs are open at once;
 *  - the random suffix is what makes repeated clicks of the same checkbox land
 *    on different branches rather than failing on "Reference already exists".
 *
 * The suffix comes from `randomUUID`, so it is 24 bits of CSPRNG per click —
 * collision is not a practical concern, and {@link createStackedPr} retries on
 * the 422 anyway rather than trusting that.
 */
export function stackedBranchName(touch: string, pullNumber: number, headSha: string): string {
  const slug = touch.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
  return `diffsentry/${slug}/pr-${pullNumber}-${headSha.slice(0, 7)}-${suffix}`;
}

/** Best-effort human-readable reason from an unknown throw. */
export function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; message?: string; response?: { data?: { message?: string } } };
    const apiMessage = e.response?.data?.message ?? e.message;
    if (apiMessage) return e.status ? `${apiMessage} (HTTP ${e.status})` : apiMessage;
  }
  return String(err);
}

function isRefExists(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  return !!e && e.status === 422 && /already exists/i.test(e.message ?? "");
}

/**
 * Write one file onto `branch`, returning the resulting commit sha.
 *
 * The blob sha lookup is scoped to `branch` — on a freshly cut stacked branch
 * that is the same tree as the head branch, and on the head branch it is what
 * the Contents API requires to replace rather than reject.
 */
async function writeFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
): Promise<string> {
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
    if (!Array.isArray(data) && "sha" in data) sha = data.sha;
  } catch {
    // Absent on this ref — a new file (a generated test, say). Create it.
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });

  return data.commit.sha!;
}

/**
 * Apply `edits` to `branch`, collecting rather than swallowing per-file errors.
 *
 * A file that cannot be written used to produce a `logger.warn` and nothing
 * else, so a run where every write was refused reported "No files needed
 * updates" — indistinguishable from a clean no-op. The failures come back now.
 */
async function writeAll(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  edits: FileEdit[],
  commitMessage: string,
): Promise<{ filesChanged: number; commitSha?: string; failures: WriteFailure[] }> {
  let commitSha: string | undefined;
  let filesChanged = 0;
  const failures: WriteFailure[] = [];

  for (const edit of edits) {
    try {
      commitSha = await writeFile(octokit, owner, repo, branch, edit.path, edit.content, commitMessage);
      filesChanged++;
    } catch (err) {
      const message = describeError(err);
      logger.warn({ err, path: edit.path, branch }, "Failed to commit file change");
      failures.push({ path: edit.path, message });
    }
  }

  return { filesChanged, commitSha, failures };
}

/**
 * Push `edits` straight onto the PR's head branch — the delivery DiffSentry has
 * always had, now reporting its write failures.
 */
export async function commitToHeadBranch(
  octokit: Octokit,
  context: PRContext,
  edits: FileEdit[],
  commitMessage: string,
): Promise<StackedPrOutcome> {
  const { filesChanged, commitSha, failures } = await writeAll(
    octokit,
    context.owner,
    context.repo,
    context.headBranch,
    edits,
    commitMessage,
  );

  return {
    filesChanged,
    commitSha,
    failures,
    ...(filesChanged === 0 && failures.length > 0
      ? { error: `every file write was refused on \`${context.headBranch}\`` }
      : {}),
  };
}

export interface StackedPrOptions {
  /** Short identifier for the finishing touch — becomes part of the branch name. */
  touch: string;
  /** Title for the new PR. */
  title: string;
  /** Body for the new PR. */
  body: string;
  /** Commit message for each file write. */
  commitMessage: string;
}

/**
 * Cut a branch off the PR head, write `edits` there, and open a PR back into
 * the PR's head branch.
 *
 * Conservative by construction, because this writes to someone else's
 * repository:
 *  - the head branch is never written to, never force-pushed and never moved;
 *  - nothing is ever deleted, including a branch we cut ourselves and then
 *    failed to open a PR for — it is reported as {@link StackedPrOutcome.orphanBranch}
 *    so the generated work is recoverable rather than destroyed;
 *  - the branch is cut from the *live* head ref, so the stacked PR's diff is
 *    only the finishing touch and not a silent revert of commits pushed since
 *    the review started.
 */
export async function createStackedPr(
  octokit: Octokit,
  context: PRContext,
  edits: FileEdit[],
  options: StackedPrOptions,
): Promise<StackedPrOutcome> {
  const { owner, repo, headBranch } = context;
  const log = logger.child({ owner, repo, pr: context.pullNumber, touch: options.touch });

  if (edits.length === 0) return { filesChanged: 0, failures: [] };

  // 1. Where the stack sits. Read the live ref rather than reusing
  //    `context.headSha`: if the author pushed while the model was thinking,
  //    branching from the reviewed sha would make the stacked PR look like it
  //    reverts their push.
  let baseSha: string;
  try {
    const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${headBranch}` });
    baseSha = data.object.sha;
  } catch (err) {
    const message = describeError(err);
    log.warn({ err }, "Could not read the PR head ref for a stacked PR");
    return {
      filesChanged: 0,
      failures: [],
      error: `I couldn't read the head branch \`${headBranch}\` to stack onto: ${message}`,
    };
  }

  // 2. Cut the branch. `Reference already exists` is retried with a fresh
  //    random suffix — two clicks landing in the same millisecond must not
  //    make the second one fail.
  let branch = "";
  let created = false;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    branch = stackedBranchName(options.touch, context.pullNumber, baseSha);
    try {
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
      created = true;
    } catch (err) {
      lastError = describeError(err);
      if (isRefExists(err)) {
        log.warn({ branch }, "Stacked branch name collided; retrying with a fresh suffix");
        continue;
      }
      log.warn({ err, branch }, "Could not create the stacked branch");
      break;
    }
  }
  if (!created) {
    return {
      filesChanged: 0,
      failures: [],
      error: `I couldn't create a branch to stack onto \`${headBranch}\`: ${lastError}`,
    };
  }

  // 3. The same Contents API writes the branch path makes, aimed at the new ref.
  const { filesChanged, commitSha, failures } = await writeAll(
    octokit,
    owner,
    repo,
    branch,
    edits,
    options.commitMessage,
  );

  if (filesChanged === 0) {
    // An empty branch would make `pulls.create` 422 with "No commits between".
    // Say what happened instead, and leave the ref alone — this module never
    // deletes anything in the operator's repository.
    return {
      filesChanged: 0,
      commitSha,
      failures,
      orphanBranch: branch,
      error: `I created \`${branch}\` but could not write any file to it, so there was nothing to open a PR for.`,
    };
  }

  // 4. The stack itself: base is the reviewed PR's head branch.
  try {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      title: options.title,
      body: options.body,
      head: branch,
      base: headBranch,
    });
    log.info({ branch, number: data.number }, "Opened stacked PR");
    return {
      filesChanged,
      commitSha,
      failures,
      stacked: { branch, number: data.number, url: data.html_url, base: headBranch },
    };
  } catch (err) {
    const message = describeError(err);
    log.warn({ err, branch }, "Stacked branch was pushed but the PR could not be opened");
    return {
      filesChanged,
      commitSha,
      failures,
      orphanBranch: branch,
      error: `I pushed the changes to \`${branch}\` but couldn't open a PR into \`${headBranch}\`: ${message}`,
    };
  }
}

/**
 * Deliver `edits` to wherever the user asked for them.
 *
 * The one place the two destinations meet, so a new finishing touch cannot
 * support one and quietly not the other.
 */
export async function deliver(
  octokit: Octokit,
  context: PRContext,
  edits: FileEdit[],
  delivery: Delivery,
  options: StackedPrOptions,
): Promise<StackedPrOutcome> {
  return delivery === "stacked"
    ? createStackedPr(octokit, context, edits, options)
    : commitToHeadBranch(octokit, context, edits, options.commitMessage);
}

/**
 * The receipt DiffSentry posts after a finishing touch.
 *
 * Single source for all four touches so no path can forget to mention a
 * failure. `subject` is the noun phrase for what was produced ("docstrings",
 * "unit tests"), `emptyNote` what to say when the model returned nothing.
 */
export function formatDeliveryReply(
  outcome: StackedPrOutcome,
  subject: string,
  emptyNote: string,
): string {
  const lines: string[] = [];

  if (outcome.stacked) {
    lines.push(
      `Opened ${outcome.stacked.url} with ${subject} for ${outcome.filesChanged} file(s), ` +
        `stacked on \`${outcome.stacked.base}\`.`,
    );
  } else if (outcome.error) {
    lines.push("> [!WARNING]", `> ${outcome.error}`);
    if (outcome.orphanBranch) {
      lines.push(
        "",
        `The generated changes are on \`${outcome.orphanBranch}\` — nothing was deleted, ` +
          `so you can open the PR by hand or delete the branch.`,
      );
    }
  } else if (outcome.filesChanged > 0) {
    const sha = outcome.commitSha ? ` Commit: \`${outcome.commitSha.slice(0, 7)}\`` : "";
    lines.push(`Applied ${subject} to ${outcome.filesChanged} file(s).${sha}`);
  } else {
    lines.push(emptyNote);
  }

  if (outcome.failures.length > 0) {
    lines.push("", `I couldn't write ${outcome.failures.length} file(s):`);
    for (const f of outcome.failures) lines.push(`- \`${f.path}\` — ${f.message}`);
  }

  return lines.join("\n");
}
