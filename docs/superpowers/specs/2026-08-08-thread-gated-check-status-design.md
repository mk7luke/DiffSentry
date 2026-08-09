# Thread-gated `DiffSentry` commit status

**Date:** 2026-08-08
**Status:** Approved

## Problem

A PR with three unresolved DiffSentry review threads shows a green `DiffSentry`
check reading "No reviewable files", and `@diffsentry ship` cannot turn it red.
Three independent defects stack to produce this.

### 1. A merge commit produces an empty incremental diff

After GitHub's "Update branch" button adds a `Merge branch 'main' into …` commit,
every file's patch against the base is byte-identical to what was reviewed at the
previous head SHA. `partitionFilesForReview` (`src/reviewer.ts:124`) routes them
all to `filesSkippedSimilar`, leaving `filesToReview` empty.

### 2. The empty-diff branch hard-codes green

`src/reviewer.ts:836-841` writes `success` / `"No reviewable files"` for the
`DiffSentry` context on the *new* head SHA and returns. It never reads the
previous head's verdict, and never looks at open threads. A `failure` earned on
the prior SHA is silently discarded by a merge commit that addressed nothing.

### 3. Unresolved threads have never gated the status at all

`src/reviewer.ts:1904-1907` maps `APPROVE → success`, `COMMENT → success`,
`REQUEST_CHANGES → failure`. A `COMMENTED` review with any number of unresolved
threads is green. So fixing defect 2 alone — by preserving the prior status —
would change nothing on the reported PR, because the prior status was already
green.

Relatedly, `refreshReviewCommitStatus` (`src/reviewer.ts:477-510`) bails at line
493 unless the status is already `failure`/`error`, and only ever writes
`success`. It is strictly one-directional: PR #115 taught it to clear a stale
red, but nothing in the system can re-red a check. That is why `ship` reported
"3 unresolved review threads" and left the check passing in the same breath.

## Approach

Make the `DiffSentry` commit status a live function of the PR's unresolved
blocking findings, rather than a write-once record of the last review verdict.
Severity gates which threads count, so a stray nitpick does not block a merge.

## Design

### 1. Make severity readable off a live thread

Finding severity (`critical | major | minor | trivial`, `src/types.ts:282`)
exists at review time but is lost once the thread is posted — nothing in the
comment body is machine-readable on the way back.

A new module `src/thread-severity.ts` owns the wire format, so the writer and
the reader share one definition:

```ts
export const SEVERITY_MARKER_PREFIX = "diffsentry-severity:";
export function renderSeverityMarker(severity: CommentSeverity): string;
export function parseThreadSeverity(body: string): CommentSeverity | undefined;
```

`parseThreadSeverity` reads the last `<!-- diffsentry-severity:… -->` marker in
the body and validates it, returning `undefined` for a missing, malformed, or
unrecognised value.

A dedicated module rather than a helper in `src/ai/parse.ts`: `src/github.ts`
must call the parser, and importing the AI layer from the GitHub client would
invert the dependency direction. `VALID_SEVERITIES` (`src/ai/parse.ts:88`) is
module-private today; it moves here and `parse.ts` imports it back.

`formatCommentBody` (`src/ai/parse.ts:297-345`) already emits a hidden
`<!-- diffsentry-fingerprint:… -->` marker. Emit `renderSeverityMarker(…)` as a
sibling whenever `comment.severity` is set, following the same convention.

`fetchAllReviewThreads` (`src/github.ts:1423-1460`) fetches
`comments(first: 1) { nodes { author { login __typename } } }` on its cheap
branch. Add `body` to that node. The thread's first comment *is* DiffSentry's
finding, so this costs no extra round trip and leaves the `includeAllComments`
branch unchanged.

### 2. Extend the thread summary

`ReviewThreadSummary` (`src/github.ts:16-22`) gains one field:

```ts
/** Unresolved bot threads that gate the commit status. */
botUnresolvedBlocking: number;
```

A thread counts toward it when all of the following hold:

- `isOurBotThread` is true (human-opened threads never gate),
- `isResolved` is false,
- its parsed severity is `critical`, `major`, **or absent**.

Absent severity counts as blocking. This is fail-safe: no PR goes green because
DiffSentry could not read its own thread. It also covers every thread posted
before this ships, since those carry no marker. That population drains as open
PRs merge.

### 3. One function decides the status

New pure function — placed in `src/ship-check.ts`, which already holds the
verdict-derivation logic and is already unit-tested:

```ts
export function resolveReviewStatus(input: {
  approval?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  threads: ReviewThreadSummary;
  /** Description to use when nothing is blocking, e.g. "No reviewable files". */
  successDescription: string;
}): { state: "success" | "failure"; description: string }
```

Rules, in order:

1. `threads.botUnresolvedBlocking > 0` → `failure`, described as
   `"N unresolved blocking finding(s)"`.
2. `approval === "REQUEST_CHANGES"` → `failure`, `"Changes requested"`.
3. Otherwise → `success` with `successDescription`.

`approval` is optional: the empty-diff path has no verdict of its own and passes
only threads.

This is the entire behavioural change, in one place. The equivalent logic is
currently smeared across three call sites that each got it slightly differently.

### 4. Route every status writer through it

| Site | Today | After |
|---|---|---|
| `reviewer.ts:1903` final verdict | `statusMap[approval]` | `resolveReviewStatus` with the live thread summary |
| `reviewer.ts:836` empty diff | hard-coded `success` | fetch thread summary, `resolveReviewStatus`, `successDescription: "No reviewable files"` |
| `reviewer.ts:477` `refreshReviewCommitStatus` | one-directional | bidirectional |
| `ship` command | reads possibly-stale statuses | refreshes first, then reads |

For the final-verdict site, the thread summary must be read *after* the review's
own threads are posted and after push auto-resolve has run, so the count reflects
the PR's true state at the end of the pass.

`refreshReviewCommitStatus` becomes bidirectional:

- Replace the `state !== "failure" && state !== "error"` early-out at line 493
  with `if (state === null) return false` — i.e. no-op only when we have never
  posted this context on this SHA. That preserves the config-free short-circuit
  the original comment describes: a repo with `reviews.commit_status: false`
  has no status to find, so it never acquires one. It also keeps the function
  from inventing a status for a SHA no review pass has touched.
- Otherwise compute the target via `resolveReviewStatus` and write only when it
  differs from the current state, so a no-op stays a no-op and no redundant
  status is posted.
- Its return value keeps meaning "the status was changed", which
  `renderShipCheck` reads as `statusRefreshed`.

Rename it to `syncReviewCommitStatus` — "refresh" implied the one-directional
clear it no longer is.

### 5. Webhook triggers

`src/webhook/dispatch.ts:449` handles only `pull_request_review_thread` with
`action === "resolved"`. The comment at lines 445-448 justifies that explicitly:
*"re-opening a thread is not grounds for writing a new failure that no review
pass ever produced."*

Under the new rule the failure **is** derived from live threads, so that
justification no longer holds. Handle `unresolved` through the same sync path,
and rewrite the comment to state the new reasoning.

There is still no loop to guard against: setting a commit status raises no thread
event.

### 6. Ship Check reads blocking vs. nit

`renderShipCheck` (`src/ship-check.ts:76-78`) files *all* unresolved threads under
Warnings. Split them:

- `botUnresolvedBlocking > 0` → a **Blocker**:
  `"N unresolved blocking finding(s)."`
- Remaining unresolved threads → a Warning, as today.

This is what flips the reported PR from 🟡 "Probably safe to ship" to 🔴 "Not
ready".

`assessShipSignals` (`src/ship-check.ts:42`) marks a failing `DiffSentry` status
stale when `isReviewFeedbackAddressed(threads)`. Narrow that to "the new rule
says green" — i.e. `botUnresolvedBlocking === 0` — so a failing status backed by
a live blocking thread is never reported as stale.

The status table gains a blocking breakdown on the existing threads row:
`| Unresolved review threads | 3 (2 blocking) |`.

### 7. Sticky status

`renderStickyStatus` (`src/sticky-status.ts:47`) shows `Unresolved threads`. Show
the blocking count alongside it, matching the Ship Check row format.

### 8. Escape hatch

New config key under `reviews`:

```yaml
reviews:
  thread_gate: blocking   # "blocking" (default) | "off"
```

- `blocking` — unresolved blocking threads gate the status, as designed above.
- `off` — `resolveReviewStatus` skips rule 1 entirely, restoring today's
  verdict-only behaviour.

The existing `reviews.commit_status: false` remains a hard off-switch for all
status writes and takes precedence.

This knob earns its keep because the change can block merges on repos that never
asked for it. Add it to `src/config-schema.ts` and the README config reference.

Note: `.diffsentry.yaml` is read from the repository's default branch, so a repo
opting out must merge the change before it takes effect on open PRs.

## Consequences

- Every currently-open PR with an unresolved bot thread goes red on its next
  event, including pure nitpicks, since legacy threads carry no severity marker
  and unknown counts as blocking. Accepted deliberately; drains as PRs merge.
- `botTotal === 0` (DiffSentry never commented) leaves the gate inert —
  `botUnresolvedBlocking` is 0, so the status follows the review verdict alone.
- Human-opened threads never gate the status.
- A `COMMENTED` review that opened a `critical` thread now produces a `failure`
  status where it previously produced `success`. This is the intended change,
  and it is what makes the check meaningful.

## Testing

Unit tests, all against pure functions or a mocked GitHub client:

- `parseThreadSeverity`: marker present for each severity; absent; malformed;
  unrecognised value; multiple markers (last wins); marker inside a fenced code
  block in the finding body.
- `summarizeReviewThreads`: `botUnresolvedBlocking` counts critical/major/absent,
  excludes minor/trivial, excludes resolved, excludes human threads.
- `resolveReviewStatus`: full truth table over `approval` ×
  `botUnresolvedBlocking` × `thread_gate`.
- Empty-diff path: writes `failure` when a blocking thread is open; writes
  `success` / `"No reviewable files"` when none is; writes nothing when
  `commit_status: false`.
- `syncReviewCommitStatus`: flips `failure → success`, flips
  `success → failure`, no-ops when already correct, no-ops when no status exists
  for the context.
- `renderShipCheck`: blocking threads land in Blockers and produce the 🔴
  verdict; non-blocking land in Warnings and produce 🟡; the mixed case renders
  both.
- `assessShipSignals`: a failing status with a live blocking thread is not
  reported as stale.
- `dispatch`: `pull_request_review_thread` / `unresolved` triggers the sync.

## Out of scope

- Backfilling severities for threads posted before this ships. They are treated
  as blocking and the population drains naturally.
- Changing which findings become threads, or the `REQUEST_CHANGES` verdict rule
  itself.
- The `DiffSentry / Pre-Merge` status, which reports things threads say nothing
  about and stays authoritative.
