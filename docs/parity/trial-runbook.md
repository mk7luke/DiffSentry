# CodeRabbit trial runbook (Phase D)

Everything else in the parity-capture workstream is scripted or already
captured (see `docs/superpowers/specs/2026-09-15-coderabbit-parity-capture-design.md`).
This document covers only the steps that need a human: they require a
personal GitHub OAuth grant and a CodeRabbit terms-of-service acceptance,
neither of which an agent can do on your behalf.

**No payment details are needed at any point.** Per coderabbit.ai/pricing,
every plan carries a 14-day free trial with no credit card required — the
14 trial days are the only scarce resource here, there is no billing
decision to make.

Do not start this until Phase C (fixture repo seeded, all ten PRs defined
under `tests/e2e/reference/2026-09/fixture-repo/pr-series/`) is complete.
Once you start the trial, the clock is running.

## 1. Steps only you can do

1. **Create the public test repository.** Go to
   `github.com/new`, name it (e.g. `diffsentry-parity-fixture`), set
   **Public**, do not initialize with a README/license/gitignore. Push the
   seeded contents of `tests/e2e/reference/2026-09/fixture-repo/` to it as
   the initial commit on `main`.
2. **Sign up at coderabbit.ai with GitHub.** Go to
   `https://www.coderabbit.ai/pricing`, click **"Get a free trial"**.
   Authenticate with **"Sign up with GitHub"** and accept the GitHub OAuth
   authorization prompt (this is the OAuth grant — only the account owner
   can approve it) and CodeRabbit's terms of service.
3. **Start the trial on the highest tier offered: Advanced ($72/dev/mo).**
   On the plan-selection screen pick **Advanced**, not Essentials or Team.
   Confirm the trial screen shows no card-entry field before continuing —
   if one appears, stop and re-check you picked the trial path, not a paid
   checkout.
4. **Install CodeRabbit on the test repository only.** During onboarding
   (or later via the CodeRabbit dashboard's Settings → your GitHub org →
   **Configure** GitHub App), choose **"Only select repositories"** and
   pick the single repo from step 1. Do not grant "All repositories" —
   this keeps the trial's per-PR reviews scoped to the fixture and out of
   any real work.

Everything after this point — opening each PR in the series
(`npm run fixture:open -- --repo <owner/name> --pr NN`), merging PR 1, and
capturing both bots' output — is scripted and can be run by an agent
session with push access to the new repo.

## 2. Capture order, and why

The tier map governs the order, not the PR table's numbering:

| Order | Action | Tier | Why here |
|---|---|---|---|
| 1 | Immediately after install, before opening any PR: check the CodeRabbit dashboard's Security tab for the fixture's seeded vulnerable dependency and planted credential | Advanced | Continuous security monitoring scans the whole repo, not a diff — it doesn't need a PR open, so grab it first while the Advanced tier is guaranteed active |
| 2 | Open PR 1, capture both bots on it, then **merge PR 1** | Free | PR 8 (merge-conflict resolution) is defined as conflicting with PR 1 and cannot be opened until PR 1 is in `main`'s history — this has to happen before step 3 regardless of tier |
| 3 | Open PR 7 (fails CI) and PR 8 (merge conflict against PR 1), capture both | Team | These are the two Team-gated surfaces (Fix CI checkbox, merge-conflict resolution) and are the ones that stop working if the trial lapses — capture them as soon as they're unblocked |
| 4 | Open the remaining PRs in any order: 2, 3, 4, 5, 6, 9, then 10 (chat commands exercised on PR 1) | Free | Nothing here is tier-gated or time-sensitive; sequencing them last spends no trial risk |

If day 1's security-tab check in step 1 finds nothing yet (the scan may
take time to complete after install), re-check it before moving past step
3 — it is still the most perishable capture.

**Open question to re-test, not a settled fact:** the September corpus
already shows per-PR security review output (Reachability / Exploitability
/ CWE fields) on a **free**, public-repo review — see
`tests/e2e/reference/2026-09/coderabbit/inline.md`. That appears to
contradict the pricing page's claim that Advanced is required for security
review. Do not assume either answer going into the trial. Re-check it at
step 1 by comparing what the Security tab and PR 1's own inline comments
show on Advanced against what the free-tier corpus already has, and record
the answer — getting this wrong in either direction (assuming it's
Advanced-only and rushing, or assuming it's free and skipping the check)
costs trial days for no reason.

## 3. What to record, per PR

For each PR, once both bots have posted:

- Save each bot's walkthrough, inline comments, review summary, and status
  comment as text, following the existing `walkthrough.md` / `inline.md` /
  `review-summary.md` / `status.md` naming used in
  `tests/e2e/reference/2026-09/{coderabbit,diffsentry}/`.
- Screenshot the surface the PR was designed to provoke (see the PR table
  in the design spec) — e.g. for PR 7, screenshot the Fix CI checkbox; for
  PR 8, the merge-conflict resolution UI; for PR 9, the Change Stack view.
- Note the tier the surface required, and whether it matched the tier map
  in `docs/parity/CodeRabbit-parity-brief.md` — a mismatch is itself a
  finding for the drift doc (`tests/e2e/reference/2026-09/drift.md`).
- For PR 1 specifically, also capture PR 10's chat-command exchange before
  merging, since PR 10 reuses PR 1 rather than opening a new PR.

## 4. Stopping cleanly at the end of 14 days

1. In the CodeRabbit dashboard, go to Settings → your GitHub org →
   **Configure**, and uninstall the GitHub App from the test repository
   (or remove the repository from its access list).
2. Confirm no payment method was ever attached: Settings → Billing should
   show the trial with nothing to cancel, since no card was entered in
   step 3 above.
3. Archive or delete the public test repository once every PR's capture is
   confirmed checked in under `tests/e2e/reference/2026-09/` — do this
   only after step 3 above ("What to record, per PR") is complete for all
   ten PRs, since access to the trial's output disappears with the
   uninstall in step 1.
