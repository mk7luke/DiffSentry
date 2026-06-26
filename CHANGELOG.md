# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- Enforce the default-branch `.diffsentry.yaml` across all PRs (#19).
- Switch the default DiffSentry review profile to assertive (#18).
- Replace "no structured response from AI" with a useful summary (#15).
- Use `max_completion_tokens` for gpt-5+ models.
- Group recent reviews by PR, surface issues, and scale the approval mix in the dashboard.

### Fixed

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
