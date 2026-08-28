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
  Any unresolved review thread holds the notes back, at every severity and from
  any author, and resolving the last one is itself a trigger. ("Minor and
  trivial never block" governs the `DiffSentry` check; these notes are a summary
  of a finished PR, not a merge gate.) A review still in progress holds them
  too, since CI regularly goes green mid-review and a finding that has not been
  posted yet cannot gate anything — as does a review that came back red, which
  is the only place a finding that named no file is visible. One comment per
  PR, rewritten in place when a later push goes green. Off by default.
  - **Action required for existing installs:** the App must be subscribed to
    the **Check suite** and **Status** webhook events and hold the
    **Checks: Read** permission. Events an App is not subscribed to are never
    delivered, so without this the feature is silent.

### Fixed

- A non-numeric `GITHUB_APP_ID` (a stray prefix, the OAuth Client ID, the app
  slug) no longer boots and then fails every GitHub call with an opaque 401
  (`'Issuer' claim ('iss') must be an Integer'`). `loadConfig()` rejects it at
  startup, and the diagnostics GitHub App ID check fails the same way instead
  of reporting "set" as healthy.

- A PR description that so much as *mentions* DiffSentry's summary marker is no
  longer partly deleted by the next review. `injectSummaryIntoPRBody` located
  its block with a plain `indexOf` over the raw body, so the first textual
  occurrence anywhere — including one quoted inside backticks in ordinary prose
  — anchored the splice, and everything from there to the end of the real block
  was replaced by the new summary. The PR that introduced this changelog entry
  did it to itself: it described the marker in its own "Root cause" section and
  lost 3189 bytes, 35 lines, of its own description, with no edit event and
  nothing to diff against. Both markers must now sit alone on their own line —
  which is how the block is written and never how prose quotes it — and the last
  end marker is paired with the nearest start marker before it. Re-reading the
  live body does not help here; the loss was in the merge, not the staleness.

- Editing a PR description while a review is running no longer gets that edit
  silently reverted. The summary block was written back on top of the
  description as it looked *before* the review's model calls started — a
  snapshot minutes stale by the time the summary existed — so anything the
  author saved in between was overwritten with no trace. Worst case it undid an
  edit made to satisfy one of DiffSentry's own description findings, which the
  next review then re-raised against text DiffSentry itself had restored. The
  summary is now merged onto the description read back immediately before the
  write, callers can no longer supply a body at all, and a description that
  already carries the current summary is left alone rather than rewritten (each
  rewrite notifies watchers and fires another `pull_request.edited`). If the
  live description can't be read, it is left untouched instead of being
  reverted to the snapshot.

- The `DiffSentry` check no longer passes with unresolved `major` findings on
  the PR. The severity gate had never once fired: GitHub reports a bot's login
  two ways — REST appends `[bot]`, GraphQL's `Bot` node does not — and the
  thread reader compared the GraphQL login against the REST form, so it matched
  nothing. Every thread summary came back `botTotal: 0`, and the check was green
  whenever the review pass's own verdict wasn't `REQUEST_CHANGES`, exactly as it
  had been before the gate was added. The same predicate backed `ship`'s stale-
  check detection and push auto-resolve, so those had never worked either. Both
  logins are now normalised before comparing, and a thread carrying DiffSentry's
  footer counts as ours even under a renamed `BOT_NAME` — while another vendor's
  review bot no longer does, at all. The unit fixtures that hid this were written
  in the REST shape; they now carry the shape GitHub actually returns.
- Push auto-resolve no longer risks burying a finding it closed. It resolves
  every DiffSentry thread on a file the push touched — "the file changed" is all
  it knows, never "the finding was addressed" — and cross-review dedup would
  then have suppressed the next pass's re-raise, leaving a live `major` on
  neither the PR nor the check. Closing a thread now retires its dedup
  fingerprint **and its file's recorded SHA**, so the next pass both may raise
  the finding again and actually re-reads the file — dropping only the
  fingerprint would leave the finding un-suppressed on a file the incremental
  pass skips, which is most of them, since auto-resolve works from the PR's
  whole diff rather than the push delta. Only a resolution nobody undid makes it
  stick; a resolution by a human stays permanent, since that one carries a
  judgement. The synchronize webhook now chains the review behind auto-resolve
  rather than running the two side by side, so the pass reads state after the
  retirement rather than racing it.
- The sticky 📌 Status comment no longer reads 🟢 Approved above its own
  "Unresolved threads: 2" row. It was showing the verdict of the last review
  pass, which describes only the diff that pass read — so a follow-up push
  touching two files legitimately came back `APPROVE` while the findings from
  the previous pass sat open. The card now shows the PR's verdict: 🔴 while a
  blocking finding is open, 🟡 while any other thread is unresolved, 🟢 only on
  a clean thread list, with a line saying which it is when that differs from the
  pass's own verdict.
- Automatic release notes no longer post underneath a 🔴 Changes requested
  status. The gate read our own commit status only for `pending`, so a red
  verdict — including a `REQUEST_CHANGES` resting on a PR-level finding, which
  opens no thread and was therefore invisible to the thread gate — let the notes
  through. Red now holds them, and both writers of that status re-ask once it
  goes green.
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
