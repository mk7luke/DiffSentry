# Parity reference corpus — September 2026

A dated snapshot of how CodeRabbit and DiffSentry actually comment on pull
requests, captured 2026-09-15. It exists so the parity rubric can be argued
from evidence instead of memory.

## What is in here

| Path | Contents |
|---|---|
| `coderabbit/` | 18 public PRs, 17 primary languages, 121 bot comments. Captured 2026-09-15T18:34:35Z. |
| `diffsentry/` | 18 PRs from `mk7luke/DiffSentry`, 87 bot comments. Captured 2026-09-15T18:51:27Z. |
| `screenshots/` | 10 rendered PNGs of both bots on GitHub, plus `screenshots/README.md` describing each and how to retake them. |
| `drift.md` | The analysis: April→September change in CodeRabbit's comment shape, then CodeRabbit vs DiffSentry as of September. |
| `fixture-repo/` | A self-contained "reports" service used to generate PRs that provoke specific review behaviours. Documented in `fixture-repo/README.md`; not part of the captured corpus. |

Each bot directory holds the same files:

- `manifest.json` — the bot login, the capture timestamp, the PR list with
  repo/number/language/URL, and per-surface counts.
- `raw.json` — every captured comment, unclassified.
- `walkthrough.md`, `review-summary.md`, `inline.md`, `status.md`, `chat.md` —
  the same comments bucketed by surface, each entry carrying its source URL
  and file location.

Surface counts as captured:

| Surface | CodeRabbit | DiffSentry |
|---|---|---|
| walkthrough | 15 | 10 |
| review-summary | 25 | 23 |
| inline | 76 | 8 |
| status | 0 | 28 |
| chat | 5 | 18 |

The inline counts are **not** a quietness comparison. The DiffSentry sample is
18 recent PRs on its own repository, most of them Dependabot bumps and CI
changes that drew no findings; the CodeRabbit sample is 18 unrelated public
repositories across 17 languages. Any claim about inline comments has to carry
both sample sizes (76 vs 8) — see `drift.md`, which states this beside every
such claim.

## The April 2026 baseline is deliberately frozen

The files directly under `tests/e2e/reference/` — `CODERABBIT-FORMAT.md`,
`coderabbit-walkthroughs.md`, `coderabbit-reviews.md`,
`coderabbit-inline-comments.md` and their `.json` siblings — are the **April
2026 baseline**, taken from a single PR (`jasonkneen/codesurf#5`, 28 reviews,
one repository, one language). They are not updated when a new dated corpus
lands. Their whole value is being a fixed earlier point to measure against; a
refreshed baseline would answer no questions.

`CODERABBIT-FORMAT.md` is the rubric written off that April snapshot. It is
still the document to read when adding a "match CodeRabbit" surface, but read
`drift.md` alongside it: several of its surfaces have since changed shape, two
were removed by CodeRabbit outright, and one (Surface 4, "Status / control
issue comments") describes a separate-comment pattern that the April capture
itself does not show CodeRabbit using.

## Re-running the capture

```bash
npm run capture:coderabbit   # public PRs commented on by coderabbitai[bot]
npm run capture:diffsentry   # PRs on mk7luke/DiffSentry
```

Both wrap `scripts/capture-corpus.ts`, which shells out to `gh` and needs an
authenticated CLI. Selection judgment (which PRs, which bucket, what to
redact) lives in `src/parity/corpus.ts` and is unit-tested in
`tests/unit/parity-corpus.test.ts`.

**Re-running against the network replaces the sample.** `gh search` orders by
most-recently-updated, so a re-scrape silently draws different PRs while the
counts above stay in the prose that cites them. Treat a captured corpus as a
fixed artifact. To verify a classifier change without re-scraping, re-bucket
the existing capture in place:

```bash
npx tsx scripts/capture-corpus.ts --from-raw tests/e2e/reference/2026-09/coderabbit/raw.json \
  --out tests/e2e/reference/2026-09/coderabbit
```

A genuinely new snapshot belongs in a new dated directory
(`tests/e2e/reference/<YYYY-MM>/`), not on top of this one.

## Secret scrubbing

Every comment body is passed through `scrubSecrets` (`src/parity/corpus.ts`)
before it is written to `raw.json` or any `.md` file. It replaces PEM private
key blocks, GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`),
AWS access key IDs (`AKIA…`), OpenAI-style `sk-…` keys, and Slack `xox…`
tokens with `[REDACTED]`. The patterns are deliberately broad: over-redacting
costs one sample, missing costs a leak.

All captured repositories are public, and every screenshot was taken logged
out.
