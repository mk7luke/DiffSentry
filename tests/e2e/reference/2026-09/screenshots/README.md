# Rendered screenshots — 2026-09 parity corpus

These PNGs record what the raw API/markdown corpus (`../coderabbit/*.md`,
`../diffsentry/*.md`) cannot: how each bot's comments actually *render* on
GitHub — whether a `<details>` block starts collapsed or open, how a
severity header reads at a glance, whether a suggestion gets GitHub's native
apply affordance, and how much space a walkthrough eats before you reach
real content.

All PRs are public. Every capture was taken **logged out** — no GitHub
account, no auth token — so what you see here is what any external
reviewer or drive-by contributor sees, not a signed-in maintainer's view.
That matters for `suggestion-block.png` below: GitHub's "Add suggestion to
batch" / "Commit suggestion" buttons only render for an authenticated user
with write access to the fork, so they do **not** appear in these captures
even where CodeRabbit's own suggestion UI is fully visible.

Capture date for every file: **2026-09-15**. Viewport width for every file:
**1280px** (`browser_resize` before each screenshot). Browser: Chromium via
Playwright MCP tools (`browser_navigate`, `browser_resize`,
`browser_take_screenshot`, `browser_evaluate` to expand target `<details>`
elements and neutralize `position: sticky` headers that otherwise duplicate
into tall element screenshots).

## CodeRabbit — `coderabbit/`

Source PR for `walkthrough-*` and `review-summary`:
https://github.com/janlampert08-dev/strado/pull/249

Source PR for `inline-finding` and `suggestion-block`:
https://github.com/cryostatio/cryostat/pull/1764 (comment
`discussion_r3915066291`)

| File | Evidence of |
|---|---|
| `walkthrough-collapsed.png` | The single CodeRabbit walkthrough comment (`issuecomment-5685603014`) as it renders by default: everything below the top banner — including the `📝 Walkthrough` summary itself — starts inside collapsed `<details>`. The comment also happened to be live-reprocessing at capture time ("Currently processing new changes in this PR..."), which is itself evidence for the finding below: CodeRabbit has no separate status comment, it splices a live status note into the top of this same walkthrough comment and edits it in place. |
| `walkthrough-expanded.png` | The same comment with only the outer `📝 Walkthrough` `<details>` opened (nested per-file/sequence-diagram `<details>` left collapsed, matching what a reader would open first). Shows the file-change table, priority/effort estimate, and a rendered Mermaid sequence diagram — which required scrolling it into view once before capture, since GitHub lazy-renders Mermaid blocks on visibility. |
| `review-summary.png` | The "Actionable comments posted: 3" review body (`pullrequestreview-5214188241`), including the caution callout for comments outside the diff, one severity-tagged outside-diff finding, and three already-resolved inline threads below it with GitHub's native "Show resolved" collapse control. |
| `inline-finding.png` | One inline finding (`discussion_r3915066291`, `JfrView.java`) with its full severity header (`🎯 Functional Correctness | 🟡 Minor | ⚡ Quick win`), the file path bar and diff hunk above it, and a collapsed "📝 Committable suggestion" section — plus a green "✅ Addressed in commits" badge. **That badge is CodeRabbit-emitted text, not GitHub chrome**: it sits in the comment body after the `<!-- auto-generated reply -->` marker (`../coderabbit/inline.md:559`, `:823`), and DiffSentry emits none. |
| `suggestion-block.png` | The same comment with "📝 Committable suggestion" expanded, showing CodeRabbit's own red/green "Suggested change" diff block and its "‼️ IMPORTANT — carefully review before committing" notice. **GitHub's native apply UI (the "Add suggestion to batch" / "Commit suggestion" buttons) is not visible** — that chrome is permission-gated to authenticated users with write access, and this capture is deliberately logged out. What you see here is the full extent of what a logged-out visitor — or a reviewer without merge rights — ever sees of this affordance. |

**Not captured: `status-comment.png`.** Confirmed absent, not a gap. Checked
two CodeRabbit PRs (`strado#249` and `marionettejs/marionette#525`): in both,
CodeRabbit posts exactly one bot comment (the walkthrough) and no second
"status" comment ever appears in the comment list. The corpus's
`status.md: _No comments captured._` is correct — CodeRabbit's status
reporting is not a distinct surface, it's a note prepended to the walkthrough
comment and edited away once reprocessing finishes (see
`walkthrough-collapsed.png` above, captured mid-reprocess).

## DiffSentry — `diffsentry/`

Source PR for all six targets:
https://github.com/mk7luke/DiffSentry/pull/146

| File | Evidence of |
|---|---|
| `walkthrough-collapsed.png` | The DiffSentry walkthrough comment (`issuecomment-5378765564`) as it renders by default — a short, fully collapsed stack of three `<details>` (`📝 Walkthrough`, pre-merge checks, finishing touches), noticeably terser at first glance than CodeRabbit's collapsed state. |
| `walkthrough-expanded.png` | The same comment with `📝 Walkthrough` opened: change-cohort table, a rendered Mermaid sequence diagram (wider than the comment column — DiffSentry's diagram runs off the right edge with a horizontal scrollbar rather than reflowing, unlike CodeRabbit's), risk assessment with a scored table, a test-coverage signal, and a "Description Drift" section CodeRabbit's walkthrough has no equivalent of (flags that the PR description undercounts the tests actually added). |
| `review-summary.png` | The "Actionable comments posted: 0" review body (`pullrequestreview-4999429681`) — narrative summary, one nitpick bucket, "Autofix (Beta)" section, and a resolved inline thread below with the same native "Show resolved" control CodeRabbit uses. |
| `inline-finding.png` | One inline finding (`discussion_r3835448692`, `src/dashboard/markdown.ts`) with severity header (`🔒 Security | 🟡 Minor`), file path bar and diff hunk, and a collapsed "🔧 Proposed fix" section. |
| `status-comment.png` | **A real, separate sticky status comment** (`issuecomment-5378766713`, pinned 📌 "Status — last updated `a92a9c7`"), distinct from the walkthrough comment: Approved/risk badge, a table of risk score, unresolved threads, failing/pending checks, files reviewed, and a live "Updated" timestamp, with a footer noting it's "Live-updated by DiffSentry on every push." |

**Not captured: `suggestion-block.png`.** Confirmed absent, not a gap.
Grepped the full September corpus (`inline.md`, `review-summary.md`,
`walkthrough.md`, `chat.md` for both bots) for ```` ```suggestion ```` fences:
zero hits anywhere in `diffsentry/`. DiffSentry's equivalent — the "🔧
Proposed fix" section visible in `inline-finding.png` — is a plain
```` ```diff ```` code fence inside a collapsed `<details>`, not GitHub's
`suggestion` comment syntax. It renders as syntax-highlighted diff text only;
there is no red/green "Suggested change" block and no apply affordance at
all, native or bot-provided. DiffSentry currently has no committable-suggestion
surface to screenshot, on either the logged-out or (per the corpus review
profile settings) presumably the logged-in path.

## Correction to the working theory

The corpus refresh carried a working theory: "both bots captured ZERO
status-bucket comments... the in-progress comment is edited in place into the
final walkthrough rather than left standing." That's exactly right for
**CodeRabbit** (see above), but only half right for **DiffSentry**: DiffSentry
*does* maintain a standing, separate, pinned status comment
(`status-comment.png`), real and public on PR #146.

**Resolved — this was a classifier bug and it has been fixed.** An earlier
draft of this section flagged the DiffSentry `status.md` "no comments
captured" result as a suspected bucketing miss. It was one, and the
classification heuristic was corrected afterwards:
`../diffsentry/manifest.json` now records `"status": 28` and
`../diffsentry/status.md` holds all 28 bodies (18 terse
`<!-- DiffSentry Status -->` verdict blockquotes plus 10 pinned
`<!-- DiffSentry Sticky Status -->` comments). CodeRabbit's `status: 0` was
never a miss — see the note above `suggestion-block.png` and
`../drift.md` Surface 4.

Worth knowing before reading either number as a parity gap: the separate
status comment was **never a CodeRabbit behaviour** in the first place.
`tests/e2e/reference/CODERABBIT-FORMAT.md`'s Surface 4 described DiffSentry's
own pattern inside a CodeRabbit reference, and DiffSentry was built to it.
`../drift.md` Surface 4 and `docs/parity/gap-backlog.md` §1.2 carry the
evidence.

## Why Playwright isn't a repo dependency

These screenshots are captured a handful of times a year, by hand, against
public GitHub PRs — not on every CI run. Making Playwright a `package.json`
dependency would mean installing and caching Chromium/Firefox/WebKit
binaries (hundreds of MB) in CI for a capability nothing in the shipped
product uses. The cost isn't worth paying for an occasional documentation
refresh. Instead, the capture is driven through the ad hoc Playwright MCP
tools available in an agent session (`browser_navigate`, `browser_resize`,
`browser_take_screenshot`, `browser_evaluate`, `browser_snapshot`) and the
*procedure* is committed here instead of the tooling.

## How to redo these captures

1. Start a Claude Code (or similar) agent session with Playwright MCP tools
   available.
2. Get PR URLs from `../coderabbit/manifest.json` and
   `../diffsentry/manifest.json` (`prs[].url`) — don't hand-pick different
   PRs without checking they still exhibit the surface you need (e.g. a
   suggestion block, a resolved thread).
3. `browser_navigate` to the PR URL, then `browser_resize` to
   `{width: 1280, height: 1000}` before any screenshot. Do not log in —
   GitHub renders these comments identically for logged-out visitors, and
   logged-in chrome (avatars, "Sign in" buttons, private repo affordances)
   must never appear in a committed screenshot.
4. Locate the target comment via `browser_evaluate` (search `textContent`
   for a marker string, or jump straight to `#discussion_r<id>` /
   `#issuecomment-<id>` / `#pullrequestreview-<id>` anchors copied from the
   corpus `Source:` lines in `../coderabbit/*.md` / `../diffsentry/*.md`).
   Tag the element with a temporary `data-capture` attribute so the
   screenshot `target` selector is unambiguous.
5. Before any screenshot of a tall element, force every
   `position: sticky`/`fixed` ancestor to `position: static` via
   `browser_evaluate` — GitHub's sticky PR header otherwise duplicates into
   the image when Playwright stitches a multi-viewport element capture.
6. To capture an "expanded" variant, open only the specific `<details>` you
   care about (`el.open = true`), not every nested one — opening everything
   produces an unreadably long image. If a Mermaid diagram renders blank,
   scroll it into view once first; GitHub lazy-renders those on visibility.
7. `browser_take_screenshot` with `target` set to the tagged element and
   `filename` pointing at the destination PNG.
8. Open every PNG and check: does it show the surface the filename claims,
   is the text legible at full size, and is there zero logged-in-account or
   private-repo chrome visible? If not, delete and retake — never keep a
   screenshot that fails any of those checks.
