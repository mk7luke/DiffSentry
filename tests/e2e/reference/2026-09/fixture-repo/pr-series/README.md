# PR series

Ten PR directories applied on top of the `fixture-repo` seed for the
CodeRabbit/DiffSentry parity capture (see
`../../../../../docs/superpowers/specs/2026-09-15-coderabbit-parity-capture-design.md`
for the full design). Each directory holds:

- `pr.json` — `{ title, body, base, branch, expects }`. Loaded and validated
  by `src/parity/fixture.ts`.
- `files/` — complete file contents to copy over the fixture checkout for
  that branch. Data, not a patch, so it stays readable in review and needs
  no nested git repo.

Every PR is a real, reviewable change with an honest reason to exist. The
planted problem rides inside that change rather than sitting in a PR whose
only purpose is to carry a bug — a reviewer should not be able to tell which
change exists to provoke a specific finding.

## The ten PRs

| # | Directory | Provokes | Planted problem(s) |
|---|---|---|---|
| 1 | `01-report-tags-search-export` | Walkthrough cohorts, sequence diagram, full severity range, security | Command injection via the `x-owner-id` header in the zip-export shell-out (`src/export.ts`); a missing-authorization (IDOR) gap on `PATCH /reports?id=` that never checks the report belongs to the requesting owner (`src/router.ts`); an N+1 pattern in the tag digest, one HTTP request per report instead of a batched lookup (`src/tags.ts`) |
| 2 | `02-pagination-limit-offset` | Committable suggestion / one-click fix | An off-by-one in the new `limit` handling (`rows.slice(offset, offset + limit - 1)` drops the last row of every page) |
| 3 | `03-pr-preview-workflow` | Workflow analysis (zizmor-class), security | A new `preview` job triggers on `pull_request_target`, checks out the PR's own head SHA, and runs `npm install`/`npm run build` from that untrusted checkout with `secrets.GITHUB_TOKEN` available — the classic "pwn request" shape. The new job also references `actions/checkout@v4` and `actions/setup-node@v4` by tag instead of the SHA pins the existing jobs use |
| 4 | `04-openapi-tags-pagination` | Schema-diff analysis (oasdiff-class), breaking change | `ownerId` is dropped from the `Report` schema's `properties` and `required` list while documenting the unrelated `tags`/pagination additions — a removed required response field |
| 5 | `05-docs-troubleshooting-deploying` | Style analysis (Vale-class) | Passive voice throughout the new Troubleshooting/Deploying sections, and inconsistent terminology (`report` / `record`, `owner` / `tenant` used interchangeably) |
| 6 | `06-ingest-dedupe-checkpoint` | Language-agnostic review path | A bare `except:` that swallows every exception, including ones that should propagate; a check-then-act race in `poll_without_duplicates` — the seen-ids file is read once at the start of a run and written once at the end, so two overlapping invocations can each decide the same item is new and forward it twice (`ingest/worker.py`) |
| 7 | `07-retention-boundary-test` | Fix-CI affordance | A new boundary test in `test/store.test.ts` asserts a report exactly at the retention cutoff is *kept*, but `Store.prune`'s comparison is strict (`now - createdAt < olderThanMs`), so it is actually pruned — the suite genuinely goes red |
| 8 | `08-report-create-rate-limit` | Merge-conflict resolution | Edits the same lines of `src/router.ts`'s `handleCreate` that PR #1 edits (the final `store.insert(...)` call), on a branch cut from `main` before PR #1 merges. Opening it after PR #1 has merged produces a real `git merge` conflict — verified locally: `CONFLICT (content): Merge conflict in src/router.ts` |
| 9 | `09-layered-refactor-archive` | Change Stack / layering, effort estimate, security, dependency advisory | Splits `router.ts` into `src/routes/*` and adds a scheduled archival job. The archival client falls back to a hardcoded AWS credential pair when the environment doesn't provide one (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` — AWS's own published documentation example, never a real or revoked key) in `src/archive/s3Client.ts`; ships `package.json.tmpl` (applied as `package.json` when the PR is opened — see Safety notes) pinning `lodash@4.17.15`, which carries multiple high-severity advisories (command injection, prototype pollution) per `npm audit` |
| 10 | `10-chat-commands-on-01` | Agentic chat (generate-tests, autofix) | Not a new PR. Records the chat commands (`/diffsentry generate-tests`, `/simplify`, `/tldr`, `/rubber-duck`, `/autofix`) to run against the already-open PR #1, to compare each bot's follow-through on its own review comments rather than its first-pass review |

## Ordering

PRs 1–7 and 9 are independent and can be opened in any order against `main`.
PR #8 must not be opened until PR #1 has merged — it is built to conflict
with it, on purpose, and opening it earlier would just fast-forward.
PR #10 is not opened as a PR at all; its commands are issued as comments on
PR #1 after that PR's first review has landed. The apply script
(`scripts/fixture-open-pr.ts`) does not enforce this ordering itself; it is
the operator's responsibility when working through Phase D of the capture
plan.

## Safety notes

- The only planted credential anywhere in this series is AWS's own published
  documentation example, `AKIAIOSFODNN7EXAMPLE`, paired with its equally
  well-known example secret key. Neither has ever been a live or revoked
  credential.
- The vulnerable dependency (`lodash@4.17.15`, PR #9) is pinned only in the
  fixture's own `package.json`, never in this repo's `package.json` or
  lockfile, and is never installed from this repo.
- PR #9's manifest ships in this tree as `files/package.json.tmpl`, not
  `files/package.json`. `actions/dependency-review-action` (this repo's own
  `Dependency review` CI check) flags any file named `package.json` by path
  in a diff, regardless of whether it's ever installed, so a literal
  `package.json` here would fail this branch's own CI even though the
  dependency is fixture-only data. The `.tmpl` suffix keeps GitHub's
  manifest detection from seeing it while this repo's own tooling stays
  clean; `scripts/fixture-open-pr.ts` strips the suffix (via
  `applyTemplatePath` in `src/parity/fixture.ts`) when it applies the PR to
  the fixture checkout, so the opened PR still lands a real `package.json`
  there.
