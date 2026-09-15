# CodeRabbit parity: reference capture and gap classification

**Date:** 2026-09-15
**Status:** approved (brainstorm → spec)
**Input:** `docs/parity/CodeRabbit-parity-brief.md` (committed as part of this
work; previously existed only outside the repo, dated 2026-09-14)

## Problem

DiffSentry's only picture of CodeRabbit is `tests/e2e/reference/`, captured
**2026-04-16 → 04-18** from a single PR thread (`jasonkneen/codesurf#5`, 28
reviews). It is five months stale, one repo, one language, and — critically —
**raw API markdown only**. Nothing in the repo records how CodeRabbit's comments
actually *look* to a human: whether a `<details>` renders collapsed, how the
severity headers read at a glance, whether a suggestion block gets GitHub's
native "Add to batch" affordance.

`CODERABBIT-FORMAT.md` is written off that stale snapshot, and its "DiffSentry
parity gap (current vs target)" section inherits the staleness.

We cannot make good decisions about what to build until we know what CodeRabbit
emits today and how it presents.

## The classification rule

This is the governing constraint, and it applies to every gap this work surfaces.

> "CodeRabbit does X" is never on its own a reason for DiffSentry to do X.

Every observed gap is recorded with exactly one disposition and a stated reason:

- **adopt** — the capability makes sense as-is for a self-hoster.
- **adapt-lighter** — the *value* is real but CodeRabbit's implementation assumes
  SaaS-scale infrastructure. Record the value, and the lighter mechanism that
  delivers it on one operator's machine or cluster.
- **decline** — the capability is an artifact of CodeRabbit's business model
  (seats, connectors, cloud state) and delivers no self-hoster value.

A gap with no disposition is an incomplete finding. The brief's §6 "What NOT to
chase" becomes the seed of the `decline` column rather than a separate list.

## Phases

Phases A, B, C require no CodeRabbit account. Only D consumes the 14-day trial.

### Phase A — Refresh the corpus (no account)

Scrape current `coderabbitai[bot]` output from public repositories via `gh`
(already authenticated as `mk7luke`). Verified working:

```
gh search issues --commenter="coderabbitai[bot]" --include-prs \
  --visibility=public --updated=">2026-08-15" --sort=updated
```

**Selection:** 15–20 PRs, chosen for spread, not volume — at least four distinct
languages, and a mix of PR shapes (single-hunk fix, multi-file feature, large
refactor, dependency bump). Reject PRs where CodeRabbit posted only a status
comment.

**Surfaces captured**, matching the four in `CODERABBIT-FORMAT.md`:
walkthrough issue comment, review body, inline review comments, status/control
comments. Plus chat replies where present.

**Storage:** `tests/e2e/reference/2026-09/`. The April files stay exactly where
they are — they are the drift baseline, and `README.md:670` and
`docs/E2E-DEPLOY-LOOP.md` both point at their current paths. Nothing in `src/`
or `tests/` reads them, so this is additive only.

### Phase B — Capture appearance, both bots (no account)

Rendered screenshots of public PR pages. No auth required, so no credential
handling.

**CodeRabbit shots:** walkthrough collapsed *and* expanded, review summary
header, an inline finding at each severity present, a committable suggestion
block, the status comment, a chat exchange.

**DiffSentry shots:** the same surfaces from `mk7luke/DiffSentry`'s own PRs,
where `diffsentry[bot]` is live today. This is what makes the comparison
side-by-side *now*, without waiting on the test repo.

**Mechanism:** the Playwright MCP tooling available to the agent session, not a
new repo dependency. Playwright is absent from both `package.json` and
`web/package.json`; adding it would pull browser binaries into CI and onto every
contributor's machine to serve a capture run that happens a few times a year.
The screenshots are the committed artifact; the procedure is documented in
`tests/e2e/reference/2026-09/README.md` so it is reproducible. This is itself an
instance of the classification rule applied to our own tooling.

**Storage:** `tests/e2e/reference/2026-09/screenshots/{coderabbit,diffsentry}/`.

### Phase C — Build the test repo (no account, no clock)

A synthetic repository with realistic bones, authored in
`tests/e2e/reference/2026-09/fixture-repo/` and pushed to the test repo when
Phase D begins.

"Realistic bones" is a constraint on the seed, so make it checkable: the seed is
a working HTTP service with a router, a persistence layer, a background worker,
config loading, and its own test suite that passes before any PR lands. It must
build and its tests must go green on a clean clone — a seed whose tests fail
from the start makes PR #7's deliberate CI failure meaningless. Written for this
purpose rather than copied from an existing project, to avoid inheriting a
licence and an unrelated commit history.

Each PR is then a real change that happens to carry planted problems, so
triggers are controlled without the artificiality of a bug garden.

**Composition:** TypeScript primary (DiffSentry's `tsc`/`eslint` analyzers
actually run against it), Python secondary (different idioms, exercises the
language-agnostic path), plus three non-code surfaces — a GitHub Actions
workflow, an OpenAPI spec, and a Markdown doc — because those are what the
brief's P1.2 tooling pack (zizmor, oasdiff, Vale) is about and they cost almost
nothing to include.

**PR series**, each targeting a surface:

| # | PR | Provokes | Tier |
|---|---|---|---|
| 1 | Multi-file TS feature; planted injection sink, missing validation, N+1 | Walkthrough cohorts, sequence diagram, severity range | Free |
| 2 | Single-hunk pagination fix | Committable suggestion / 1-click fix | Free |
| 3 | Actions workflow: unpinned refs, `pull_request_target` misuse | Workflow analysis (zizmor-class) | Free |
| 4 | OpenAPI breaking change | Schema diff (oasdiff-class) | Free |
| 5 | Prose-heavy doc | Style analysis (Vale-class) | Free |
| 6 | Python worker; planted race, broad `except` | Language-agnostic review path | Free |
| 7 | Change that **fails CI** | Fix CI checkbox | Team |
| 8 | Branch conflicting with #1, opened after #1 merges | Merge-conflict resolution | Team |
| 9 | 25-file refactor | Change Stack / layering, effort estimate | Free/Team |
| 10 | Chat commands exercised on #1 (not a new PR) | Agentic chat | Free |

A dependency with a known advisory and a planted credential are seeded into the
fixture repo for the Advanced-tier security review. The vulnerable dependency is
pinned in the **fixture repo's own** `package.json` only. It is never added to
DiffSentry's `package.json` or lockfile, and the fixture's dependencies are
never installed in this repo — otherwise DiffSentry's own Dependabot and audit
surface would start reporting a vulnerability we planted on purpose.

**Safety:** every planted credential must be syntactically plausible but
provably non-functional — a well-known documentation/test value, never a live
or revoked real key. Planted vulnerabilities live only in the fixture repo and
in `tests/e2e/reference/`, which `.github/codeql/codeql-config.yml` already
excludes for exactly this reason ("deliberately-fake input"). `.diffsentry.yaml`
gains a matching `path_filters` exclusion — noting that per this repo's config
loading, that exclusion only takes effect once merged to `main`, so DiffSentry
is expected to flag the fixtures on the PR that introduces them.

**Both bots stay installed on the test repo.** `src/webhook/dispatch.ts` bails
on `user.type === "Bot"` at lines 283, 375 and 422, and `reviewer.ts:3642`
treats any `[bot]` suffix as botty, so DiffSentry will not parse CodeRabbit's
walkthrough as a chat command or collapse it as prior discussion. No
`.diffsentry.yaml` suppression is needed, and side-by-side is the point.

### Phase D — Trial run (consumes the 14 days)

**Blocked on the operator.** Authorizing CodeRabbit requires a GitHub OAuth
grant and ToS acceptance on a personal account; the agent does not do this.
Per coderabbit.ai/pricing, all plans carry a 14-day trial with **no credit card
required**, so no billing decision is involved.

Operator steps, when Phase C is complete and not before:
1. Create the public test repository.
2. Sign up at coderabbit.ai with GitHub; start the trial on the **highest tier
   offered** — Team gates finishing touches and merge-conflict resolution,
   Advanced gates security review; the free tier shows neither.
3. Install CodeRabbit on that repository only.

Then the PR series is opened one at a time, both bots reviewing, everything
captured. The tier map drives the ordering: Team- and Advanced-only surfaces
are captured first, because they are the ones that expire.

### Phase E — Parity backlog

Two documents:

- `tests/e2e/reference/2026-09/drift.md` — what changed in CodeRabbit's comment
  shape between April and September, and separately, where DiffSentry's current
  output differs from CodeRabbit's current output.
- `docs/parity/gap-backlog.md` — every gap with its adopt/adapt-lighter/decline
  disposition and reason, superseding the brief's wave plan where observation
  contradicts it.

`CODERABBIT-FORMAT.md` is **extended, not replaced** — the brief is explicit
that a second format doc must not be invented. Its stale "current vs target"
section is rewritten against the September corpus.

## Non-goals

- Implementing any P0/P1 feature. This work produces evidence and a corrected
  backlog; building is separate and follows from it.
- Adding Playwright, or any other dependency, to the repo.
- Creating GitHub repositories, CodeRabbit accounts, or anything requiring the
  operator's credentials or money.
- Modifying review behaviour in `src/`. The only `src`-adjacent change is the
  `.diffsentry.yaml` fixture exclusion.

## Verification

- `npm run lint` and `npm run build:server` (i.e. `tsc`) pass — the repo's
  existing gates. This change is documentation and fixture data, so neither
  should be perturbed; a failure means something was touched that should not
  have been.
- `npm test` (`vitest run`) passes, with the test count compared against `main`
  rather than read in isolation.
- Every captured artifact is checked in and non-empty; every screenshot is
  visually confirmed to show the surface it claims.
- Every gap in the backlog carries a disposition. A gap without one fails review.

## Risks

- **CodeRabbit changes under us.** The corpus is a snapshot and dates from the
  moment it is taken. Mitigated by keeping dated directories rather than
  overwriting, so drift stays measurable.
- **The trial expires mid-capture.** Mitigated by Phase C completing first and
  by ordering Phase D's captures tier-first.
- **Public-repo scraping is unrepresentative.** Real repos configure CodeRabbit
  differently. Mitigated by spread in selection, and by the test repo giving a
  controlled default-config baseline.
