# PRD: DiffSentry Web Dashboard

## Why
DiffSentry currently surfaces everything inside the GitHub PR itself. That's
fine when you're reading one PR, but loses signal as soon as you want to
ask cross-PR / cross-repo questions:

- What's the open PR backlog across our repos that DiffSentry has reviewed?
- Which paths are accumulating the most critical findings over time?
- Which authors / teams produce the highest-risk PRs?
- Which built-in / anti-pattern rules are firing the most? Are any noisy
  enough to disable?
- Which `@bot learn` learnings are actually being applied?
- What's the bot's per-finding accept rate (suggested fix vs. ignored)?

A small read-only dashboard answers those without ever leaving the data
DiffSentry already produces — you just need to persist it.

## Audience
- **Tech leads** auditing review noise and adjusting `.diffsentry.yaml`.
- **EMs** spotting risk hot spots across teams.
- **Authors** seeing their own PR history and learning patterns.
- **DiffSentry operators** (you) checking the bot is actually adding value
  per repo.

## Non-goals
- Not a replacement for GitHub PR review UX. The dashboard never needs to
  *render* a PR — it summarizes and links out.
- No write operations beyond toggling per-repo settings (and only if the
  caller is authenticated as a repo admin).
- Not multi-tenant / SaaS. Single deployment, single GitHub App
  installation set, single operator.

## Surfaces

### 1. Repos overview (`/`)
- Table: repo · open PRs reviewed · 7d findings · 7d critical · last review.
- Sort and filter by repo / activity / risk.
- Click row → repo detail.

### 2. Repo detail (`/repo/:owner/:repo`)
- 90-day risk-score sparkline (one point per reviewed PR).
- Top 10 hottest paths by critical/major findings.
- Top 10 firing pattern rules with counts and example PR links.
- Active learnings list (`@bot learn` outputs), expandable to see use count.
- Recent reviews table (last 50 PRs): #, title, author, risk, findings,
  approval state.

### 3. PR detail (`/repo/:owner/:repo/pr/:number`)
- Full review snapshot (the same payload the walkthrough's internal-state
  blob already contains).
- Findings list with severity, file, line, fingerprint, accept/dismiss state.
- Timeline of every webhook event the bot saw.
- Side-by-side comparison with the previous push (delta lists).

### 4. Findings explorer (`/findings`)
- Filterable list across all repos: severity, type, pattern source
  (AI / safety scanner / built-in / custom), age, author.
- Group by fingerprint to see "this finding has been raised on 7 PRs and
  fixed 4 times".

### 5. Operator settings (`/settings`)
- Per-repo `.diffsentry.yaml` view (read-only — actual edits go in the
  repo).
- Global toggles: pause-all, log level, AI provider switch.
- Recent error log (last 100 lines from pino).
- Health: GitHub App rate-limit usage, AI token spend per repo / day.

## Data model

DiffSentry currently writes nothing to disk except the per-repo learnings
file and the in-memory `pausedPRs` / `reviewCountByPR` maps. The dashboard
needs persistent storage. Recommend SQLite (single file, no ops) with the
following tables:

```
repos              (owner, repo, installation_id, first_seen, last_seen)
prs                (owner, repo, number, title, author, state, base_sha,
                    head_sha, created_at, closed_at, merged_at)
reviews            (id PK, owner, repo, number, sha, run_id, profile,
                    approval, summary, risk_score, risk_level,
                    files_processed, files_skipped_similar,
                    files_skipped_trivial, created_at)
findings           (id PK, review_id FK, path, line, type, severity,
                    title, body, fingerprint, source ENUM('ai','safety',
                    'builtin','custom'), confidence, accepted BOOL NULL)
events             (id PK, owner, repo, number, ts, kind, payload_json)
learnings          (id PK, owner, repo, content, created_at, applied_count)
pattern_hits       (id PK, owner, repo, rule_name, source, fingerprint,
                    review_id FK)
```

`reviews` rows are the source-of-truth for the sparkline + timeline; they
mirror the in-comment internal-state blob but live outside GitHub so we can
query across PRs.

## Tech

- **Server:** extend the existing Express server with a separate router
  mounted at `/dashboard`. Same Node process, no separate deploy.
- **Storage:** `better-sqlite3` (already a dep tree neighbor). Migrations
  via plain SQL files.
- **Auth:** GitHub OAuth. Anyone authenticated as a member of the
  installation owner org gets read access; admins get settings access.
- **Frontend:** server-rendered HTML + minimal vanilla JS for sortable
  tables. No SPA framework. Tailwind via CDN for styling.
- **Background ingest:** the existing webhook handlers double-write to
  SQLite alongside their current GitHub API actions. Backfill via a CLI
  command that reads the walkthrough state blobs from existing PRs.

## Implementation order

1. **Storage layer** — schema + migrations + a thin DAO.
2. **Webhook ingest** — write `prs` / `reviews` / `findings` / `events`
   on every existing webhook code path (no behavior change).
3. **CLI backfill** — one-time read of every walkthrough comment in every
   installed repo to seed history.
4. **Read-only routes** — repos overview → repo detail → PR detail.
5. **Findings explorer** with filters.
6. **Auth** via GitHub OAuth.
7. **Operator settings** + health page.
8. **Pattern hit analytics** dashboard tile.

## Estimate

Roughly 2–3 days of focused work. Storage + ingest is the bulk; routes
are mostly SQL → table render. No new infrastructure: same Docker
container, same port, same install path.

## Open questions

1. Multi-installation deployments — do we ever want to support running
   one DiffSentry instance against several GitHub Apps? Today the env vars
   only support one. If yes, the schema needs an `installations` table
   and per-row `installation_id` everywhere.
2. Do we want write actions on the dashboard (e.g., toggle anti-patterns
   per repo)? If yes, we need a way to either commit `.diffsentry.yaml`
   changes back to the repo via the App or store overrides locally.
3. AI token spend tracking — would require wrapping every Anthropic /
   OpenAI call to count tokens. Useful but adds friction. Could ship without
   it and add later.

## Out of scope (for now)

- Slack / email digests of dashboard data.
- Export to BI tools.
- Cross-org analytics.
