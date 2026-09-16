/**
 * The `✅ Addressed in commit(s) …` note DiffSentry leaves on a review thread
 * it auto-resolves after a push.
 *
 * Resolving a thread tells a reader that DiffSentry stopped worrying about the
 * finding. It does not tell them *what changed*, and on a PR with a dozen
 * pushes that is the only question worth asking — a thread that closed itself
 * for the wrong reason looks exactly like one that closed for the right one.
 * Naming the commits makes the claim checkable: the reader clicks the range and
 * sees whether it plausibly did the work.
 *
 * Both rendered forms are transcribed from the captured corpus
 * (`tests/e2e/reference/2026-09/coderabbit/inline.md`,
 * `tests/e2e/reference/coderabbit-inline-comments.md`) — the singular form is
 * the more common of the two (22 occurrences across both captures against 18
 * for the range form), not a degradation invented here.
 */

/** Length GitHub abbreviates a SHA to in its own UI, and the length both
 *  captured forms use. */
const SHORT_SHA = 7;

export interface AddressedRange {
  /** First commit that landed after the finding was raised. */
  from: string;
  /** The PR's current head. Equal to `from` when exactly one commit landed. */
  to: string;
}

/**
 * The commits that could have addressed a finding raised against `raisedSha`,
 * given the PR's commits oldest-first (GitHub's `pulls.listCommits` order).
 *
 * Returns null — and the caller then says nothing at all — in the two cases
 * where no honest range exists:
 *
 *   - `raisedSha` is not among the PR's commits. A force-push or a rebase
 *     rewrote the history the finding was raised against, so every SHA we could
 *     name is one the reader cannot diff against.
 *   - `raisedSha` is still the head. Nothing landed since; the thread is being
 *     closed by something other than a commit.
 *
 * Silence is the right answer to both. A wrong range is worse than no range:
 * it invites the reader to check a diff that never contained the fix and
 * conclude DiffSentry closed the thread on nothing.
 */
export function addressedCommitRange(
  raisedSha: string | undefined,
  prCommitShas: string[],
): AddressedRange | null {
  if (!raisedSha) return null;
  // Match on the short prefix in either direction: state may hold a full SHA
  // while a caller passes an abbreviated one, or the reverse.
  const idx = prCommitShas.findIndex((sha) => sharesShaPrefix(sha, raisedSha));
  if (idx === -1) return null;
  if (idx >= prCommitShas.length - 1) return null;
  return {
    from: prCommitShas[idx + 1],
    to: prCommitShas[prCommitShas.length - 1],
  };
}

function sharesShaPrefix(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, SHORT_SHA);
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/**
 * The next `findingShas` map: every live fingerprint dated, nothing else kept.
 *
 * Two rules, and both matter. **First raise wins** — a finding the model
 * repeats on a later push keeps its original SHA, because the commits that
 * addressed it are the ones after it was first said, not after it was last
 * echoed. **Only live fingerprints survive** — the map is rebuilt from
 * `postedFingerprints` rather than merged onto the previous one, so a retired
 * finding's entry falls out instead of accumulating in a blob that has to fit
 * inside a GitHub comment.
 */
export function stampRaisedShas(
  prior: Record<string, string> | undefined,
  postedFingerprints: string[],
  headSha: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const fp of postedFingerprints) {
    next[fp] = prior?.[fp] ?? headSha;
  }
  return next;
}

/** Render a range as the note body. Two forms, both from the corpus. */
export function renderAddressedNote(range: AddressedRange): string {
  const from = range.from.slice(0, SHORT_SHA);
  const to = range.to.slice(0, SHORT_SHA);
  return from === to
    ? `✅ Addressed in commit ${from}`
    : `✅ Addressed in commits ${from} to ${to}`;
}
