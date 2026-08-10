# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Release notes can now post themselves. Set `release_notes.auto: true` in
  `.diffsentry.yaml` and DiffSentry drafts the same notes `@diffsentry
  release-notes` produces, once every check on the PR's head commit has passed,
  with no comment needed. Check runs and legacy commit statuses both count;
  DiffSentry's own `DiffSentry` and `DiffSentry / Pre-Merge` checks do not.
  Unresolved critical and major findings hold the notes back, and resolving the
  last one is itself a trigger — minor and trivial never block. A review still
  in progress holds them too, since CI regularly goes green mid-review and a
  finding that has not been posted yet cannot gate anything. One comment per
  PR, rewritten in place when a later push goes green. Off by default.
  - **Action required for existing installs:** the App must be subscribed to
    the **Check suite** and **Status** webhook events and hold the
    **Checks: Read** permission. Events an App is not subscribed to are never
    delivered, so without this the feature is silent.

### Fixed

- The `DiffSentry` check no longer flips to passing when a branch-update merge
  commit produces an empty diff. Clicking "Update branch" made every file's
  patch identical to what was already reviewed, so the review pass took its
  "no reviewable files" path and wrote an unconditional `success` — erasing a
  failure earned on the previous commit. The status is now re-derived from the
  PR's live review threads instead of assumed green.
- `@diffsentry ship` can now correct the check in either direction. The refresh
  helper bailed out unless the status was already failing and only ever wrote
  `success`, so `ship` could report unresolved threads and leave the check
  passing in the same breath.

### Changed

- Unresolved `critical` / `major` DiffSentry review threads now fail the
  `DiffSentry` commit status, regardless of the review verdict — a `COMMENTED`
  review that opened a critical is a failure until that thread is resolved.
  `minor` and `trivial` findings never block. Opt out with
  `reviews.thread_gate: off`; `reviews.commit_status: false` still disables
  status writes entirely.
- Ship Check files blocking findings as blockers rather than warnings, so a PR
  with open criticals reads "Not ready" instead of "Probably safe to ship".
- **Breaking for existing PRs:** review threads posted before this release carry
  no severity marker and are treated as blocking, so open PRs with unresolved
  DiffSentry threads go red on their next event. The population drains as those
  PRs merge.
- DiffSentry now reacts to `pull_request_review_thread` `unresolved` events, not
  just `resolved`.
- The sticky status card sources its unresolved-thread count from the paginated
  thread summary rather than a single-page query, so PRs with more than 100
  threads no longer under-report.

### Added

- CI/CD build-out: the PR gate now covers unit tests, the strict `tsc` build,
  all 17 smoke scripts, the SPA + demo-mode builds, both Docker images, and
  `actionlint`, behind a single aggregate `CI passed` check. Adds CodeQL,
  dependency review, TruffleHog secret scanning, a weekly advisory `npm audit`,
  OSSF Scorecard, Dependabot, PR labelling, stale handling, `CODEOWNERS`, and a
  tag-triggered release pipeline that publishes to GHCR and drafts the release.
- Email notification channel: configure SMTP from the dashboard, not just env (#42).
- Ops Console — a live, filterable activity stream (SPA + `/api/v1/activity`) (#41).
- Responsive command-center shell and an installable, offline-capable PWA (#40).
- Notifications: channels, alert rules, weekly digest, and a per-channel test-send (#39).
- Theme system — dark/light plus density, with live admin branding (#38).
- Findings triage — accept/dismiss/snooze, bulk actions, a recurring view, and
  opt-in suppression of dismissed/snoozed findings in reviews (#37).
- AI spend instrumentation and a Cost command-center page (#36).
- Operator controls — global and per-repo settings with a Pause-All kill switch (#35).
- Platform API — bearer-token auth, a tokens management UI, and OpenAPI docs (#34).
- Admin-authored custom anti-pattern rules from the command center (#33).
- Guided first-run experience — diagnostics plus a setup wizard (#32).
- Author analytics and org-wide trends (leaderboard + trends pages) (#31).
- Learnings management surface — CRUD API and an SPA page (#30).
- Edit a repo's `.diffsentry.yaml` from the dashboard (commit or open a PR) (#29).
- Impact report — the "what DiffSentry caught for you" screen (#28).
- Live review-pipeline board (Queued → Running → Done/Failed) (#27).
- Capture, inspect, and replay raw webhook deliveries (#26).
- Cmd-K command palette and `/api/v1/search` across repos, PRs, findings, and learnings (#25).
- Action bar wiring PR and repo detail to the command endpoints (#24).
- Realtime bus and command-action substrate (SSE, write endpoints) (#23).
- API-first, read-only SPA dashboard with a `/api/v1` JSON API (#21).
- Real RBAC (viewer/author/admin) on top of dashboard OAuth (#22).
- Ordered migration runner and command-center schema (#20).
- Repo-tailored `.diffsentry.yaml`, with docs on generating one via a coding agent.
- `@bot learn` made context-aware and editable, and now applied on subsequent reviews (#12).

### Changed

- Require a dedicated `DASHBOARD_SESSION_SECRET` when `ENABLE_DASHBOARD=1` (fails fast at boot); session signing no longer falls back to `GITHUB_WEBHOOK_SECRET`.
- Enforce the default-branch `.diffsentry.yaml` across all PRs (#19).
- Switch the default DiffSentry review profile to assertive (#18).
- Replace "no structured response from AI" with a useful summary (#15).
- Use `max_completion_tokens` for gpt-5+ models.
- Group recent reviews by PR, surface issues, and scale the approval mix in the dashboard.

### Fixed

- The `DiffSentry` commit status no longer stays red after its review threads
  are resolved. That status was written once per review pass, so a
  `REQUEST_CHANGES` verdict pinned it to `failure` on the head SHA and nothing
  ever revised it — resolving threads doesn't trigger a new pass. `ship` then
  read our own stale output back as a blocker, reporting "Unresolved review
  threads: 0" and "🔴 Not ready" in the same comment. Once every
  DiffSentry-authored thread is resolved, the status is flipped back to green —
  on `ship`, on `resolve`, on push auto-resolve, and when a reply auto-resolves
  the last open thread. Third-party checks and `DiffSentry / Pre-Merge` stay
  authoritative; only DiffSentry's own review verdict is re-derived.

  Resolving a thread by hand in the GitHub UI now clears the check too, via a
  new `pull_request_review_thread` handler. That event was missing from the
  documented App setup, so check that "Pull request review thread" is ticked
  under Permissions & events — if it already is, there's nothing to do, and
  every other refresh path works without it regardless.

- A review now posts as a single timeline entry with every thread under it.
  File-scoped findings were posted through an endpoint that can't attach to a
  review, so GitHub wrapped each one in its own review — and because they had to
  go first, they stacked *above* the summary that counted them ("Actionable
  comments posted: 5" with one thread beneath it). Threads are now opened on a
  pending review and submitted together, so the body is also composed after every
  thread's fate is known and a rejected finding can still be folded into it.
- Findings that concern one file no longer land in the unresolvable "Issues not
  tied to a specific line" section. Description-drift findings and the model's
  own PR-level findings can now name the file they're about, and become
  resolvable file-scoped review threads; a blocking finding that names a real
  file but no line is threaded there too instead of being dropped. Only findings
  that genuinely span the whole change still render as review-body prose.
- Reviews after a push now judge the whole PR, not just the newest commit: the
  review prompt carries the already-reviewed files as read-only context, and the
  walkthrough, risk score, coverage signal, and split suggestion are computed
  from the full branch. Stops incremental reviews reporting earlier commits'
  work as missing.
- Docker build: the builder stage now compiles the server only, not the SPA (#43).
- Self-heal when a model rejects our chosen `reasoning_effort` (#17).
- Stop GPT-5+ reasoning models from starving review output of tokens (#16).
- Anti-pattern detection bugs surfaced while switching to the assertive profile (#18).
- Escape semicolons in Mermaid sequence-diagram labels (#14).

## [1.0.0]

- Initial self-hosted AI PR-review bot: CodeRabbit-shape walkthrough and inline
  comments, pre-AI safety scanners, insights, and `@bot` chat commands.

[Unreleased]: https://github.com/mk7luke/diffsentry/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mk7luke/diffsentry/releases/tag/v1.0.0
