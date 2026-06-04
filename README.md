# DiffSentry

Self-hosted AI-powered GitHub pull-request review bot. CodeRabbit-shape comments
plus a layer of opinionated insights, scanners, and Socratic chat commands you
won't get from CodeRabbit.

## What it does

### Comment shape (CodeRabbit-style)
- **Walkthrough comment** with a cohort-grouped Changes table, sequence diagram(s),
  effort estimate (`🎯 N (Word) | ⏱️ ~M minutes`), tips footer, and stable
  per-section HTML markers.
- **Inline review comments** with a `_⚠️ Potential issue_ | _🟠 Major_` header,
  bold one-line title, optional `🔧 Proposed fix` collapse with a diff or
  suggestion block, mandatory `🤖 Prompt for AI Agents` block, fingerprint
  hash for dedup, and trailing auto-gen marker.
- **Review summary body** with `**Actionable comments posted: N**`, per-file
  `🧹 Nitpick comments` collapse, bulk AI-agents prompt, `🪄 Autofix (Beta)`
  checkboxes, and a full `ℹ️ Review info` block (config, profile, run id,
  commits range, files processed / ignored / skipped lists).
- **Pre-merge checks** rendered as a sibling `<details>` inside the walkthrough.
- **Finishing Touches** checkboxes embedded in the walkthrough, with
  click-to-trigger handlers for generate tests / docstrings / simplify / autofix.
- **Internal-state blob** (base64-gzipped JSON inside an HTML comment) at the
  walkthrough tail. Survives bot restarts, enables true incremental review and
  `🚧 Files skipped from review as they are similar to previous changes` lists.
  Also persists a 20-point risk-score history that powers the sticky comment's
  sparkline.
- **Chat replies** wrap action acknowledgements in `✅ Actions performed`
  collapses; pause/resume use `> [!NOTE]` blockquotes with a management-command
  list, matching CodeRabbit.
- **📌 Sticky pinned status comment** — separate top-of-PR comment with
  verdict, risk score + sparkline of recent runs, unresolved threads,
  failing/pending checks, and files reviewed. Upserted every review pass.
- **🧠 Prior discussions on this file** — inline comments append a collapse
  linking to bot comments on the same path/near-line in prior merged PRs.
  Builds institutional memory.

### Insights beyond CodeRabbit (in every walkthrough)
- **🎯 Risk Assessment** — 0–100 score with weighted factors (critical findings,
  major findings, high-risk paths like `auth/`, `payment/`, `migrations/`,
  change size, effort estimate, missing-tests signal). Color-coded badge.
- **🧪 Test Coverage Signal** — counts production vs test file additions,
  flags when production code lands without test changes.
- **📦 Dependency Changes** — parses package.json, requirements.txt,
  pyproject.toml, Cargo.toml, go.mod, Gemfile diffs and shows added /
  removed / version-changed packages.
- **🧭 Description Drift** — AI compares PR description claims to actual diff
  and flags mismatches.
- **✍️ Commit Message Coach** — checks each commit subject for length,
  weak/empty wording, capitalization, trailing period. Skips Conventional
  Commits prefixes.
- **🏷️ PR Title Coach** — vague title / past-tense verb / trailing period
  detection.
- **📜 Missing License Headers** — opt-in: lists newly-added source files
  missing a configured header.
- **Suggested Reviewers** — pulled from `git blame` of the lines this PR
  modifies (not AI-guessed).
- **👥 CODEOWNERS** — parses `.github/CODEOWNERS` (last-rule-wins) and lists
  matching owners (users + teams) for the touched files.
- **🔁 Changes since last reviewed** — for each non-bot reviewer, lists the
  files modified since their last review timestamp. Quick way to know whose
  approval is now stale.
- **📊 Confidence breakdown** — when any AI finding is medium/low confidence,
  shows the high/medium/low split so reviewers can triage hypotheses fast.
- **💡 Suggested PR Split** — when cohorts span unrelated areas and the change
  is large, recommends a slice.

### Pre-AI safety scanners (zero LLM cost)
- **Secret leak detection** for AWS keys, GitHub tokens, OpenAI/Anthropic
  keys, Slack tokens, Stripe keys, Google API keys, PEM private keys, JWTs,
  generic bearer tokens. Critical findings → CHANGES_REQUESTED.
- **Stray merge marker detection** (`<<<<<<<`, `=======`, `>>>>>>>`).
- **Built-in performance / footgun heuristics**:
  - `.forEach(async ...)` — promises silently swallowed
  - `JSON.parse(JSON.stringify(...))` — lossy deep clone (use `structuredClone`)
  - `child_process.exec` with a template literal — shell-injection foothold
  - `setInterval` with no captured handle — timer leak
  - `new RegExp(<variable>)` — ReDoS / regex injection
  - `Math.random()` shaped into an ID/token (`.toString(36)`, `* 1eN`)
  - `setTimeout`/`setInterval` with a string body — eval surface
  - Wide-open CORS (`origin: '*'`, `origin: true`)
  - `Object.assign({}, ...)` — prefer spread
  - **JSX accessibility:** `<img>` without `alt`, empty `<button>` with no
    `aria-label`, `onClick` on `<div>`/`<span>` without `role`
  - **i18n:** hardcoded user-facing strings in JSX text (only on `**/*.{tsx,jsx}`)
- **User-defined `anti_patterns`** in `.diffsentry.yaml` — name + regex +
  severity + advice + optional path glob.

### Chat commands
| Command | Description |
|---|---|
| `@bot review` | Trigger an incremental review |
| `@bot full review` | Re-review every file from scratch |
| `@bot pause` / `resume` | Pause/resume automatic reviews on this PR |
| `@bot resolve` | Resolve every review thread |
| `@bot summary` | Regenerate the walkthrough + PR description summary |
| `@bot configuration` | Show the active configuration |
| `@bot learn <text>` | Save a learning for future reviews |
| `@bot generate docstrings` | Add missing docstrings and commit to the branch |
| `@bot generate tests` | Generate unit tests and commit to the branch |
| `@bot simplify` | Simplify changed code and commit to the branch |
| `@bot autofix` | Apply fixes from review comments and commit to the branch |
| `@bot tldr` | One-paragraph plain-English summary for skimming reviewers |
| `@bot tour` | File-by-file reading-order guide with a Final Check section |
| `@bot ship` | Pre-flight verdict — is this PR ready to merge? |
| `@bot rubber-duck` | Socratic questions challenging the design + the unasked question |
| `@bot 5why <target>` | Recursive 5-Whys analysis to root-cause a behavior |
| `@bot eli5` | Plain-English explanation for cross-team / non-engineer reviewers |
| `@bot timeline` | Chronological event timeline for this PR |
| `@bot bench` | Generate a micro-benchmark for the most performance-sensitive change |
| `@bot changelog` | Keep-a-Changelog format entry for this PR |
| `@bot release-notes` | Marketing-speak release notes for this PR |
| `@bot diff <PR-number>` | Compare this PR with another for file overlap |
| `@bot rewrite` | AI-rewritten title + description, applied to the PR via API |
| `@bot help` | List every command |

Anything else after `@bot` is treated as a free-form question about the PR.

### Issue support (CodeRabbit-shape)
DiffSentry runs on GitHub Issues too — not just PRs. Subscribe to the **Issues**
event in your GitHub App and the bot will:
- **Auto-triage on `issues.opened`** — posts a single CodeRabbit-style summary
  comment with **Summary**, **Key Questions**, **Suggested Labels**, **Where
  to Look** (top-level files most likely involved), and **Suggested Next
  Steps**. The comment is upserted by an HTML marker, so re-running
  `@bot summary` updates in place instead of stacking comments.
- **Skip empty issues** — when the body is shorter than ~20 chars, the bot
  posts a friendly "needs more detail" prompt instead of burning an AI call.
- **Skip bot-authored issues** — avoids loops with other automation.

#### Issue chat commands
| Command | Description |
|---|---|
| `@bot summary` | Regenerate the triage summary in place |
| `@bot plan [focus]` | Generate a step-by-step implementation plan grounded in the issue + repo file tree (optional `[focus]` narrows the scope) |
| `@bot pause` / `resume` | Stop/start auto-responses on this issue |
| `@bot configuration` | Show the active `.diffsentry.yaml` |
| `@bot learn <text>` | Save a learning for future reviews of this repo |
| `@bot help` | Show the issue-command help |
| `@bot <free-form question>` | Answer grounded in issue body, recent comments, and the repo's top-level file tree |

#### Issue config (`.diffsentry.yaml`)
```yaml
issues:
  auto_summary:
    enabled: true   # default — post a triage summary when an issue is opened
    on_edit: false  # default — don't re-summarize on body edits
  chat:
    auto_reply: true  # default — respond to @-mention questions on issues
```

The plan/summary AI call is grounded in the issue body, the most recent 30
non-bot comments, and the top-level entries of the repo's default branch (no
embeddings/semantic search — kept intentionally light to avoid latency and
cost surprises).

### Web dashboard (read-only, optional)
- **Cross-repo overview** at `/dashboard` — PRs reviewed, 7d/critical finding
  counts, last review time per repo, sortable.
- **Repo detail** with a 90-day risk sparkline, hot paths, top firing pattern
  rules, recent reviews, active `@bot learn` learnings, and the live
  `.diffsentry.yaml` fetched via the installation.
- **PR detail** with the latest review snapshot, every finding, the events
  timeline, and all prior reviews.
- **Findings explorer** at `/dashboard/findings` with severity/source/repo/age
  filters and a recurring-fingerprint group view.
- **Pattern analytics** at `/dashboard/patterns` — per-(repo, rule) 30-day +
  all-time hit counts to spot noisy rules.
- **Operator settings** at `/dashboard/settings` — runtime + storage health +
  a live warn/error log tail captured via an in-process pino ring buffer.
- **Guided first-run diagnostics** at `/settings/diagnostics` in the
  command-center SPA (served at `/` — see the deployment note below; the legacy
  `/dashboard` pages above have no diagnostics screen) — pinpoints
  missing/invalid config (GitHub App, AI provider, OAuth, DB) with fix hints,
  shows App installation + connected-repo status and webhook delivery health,
  and runs one-click test-AI / test-webhook self-tests. A setup wizard nudges
  you until the instance is healthy.
- **GitHub OAuth gating** — the dashboard is opt-in via `ENABLE_DASHBOARD=1`
  and requires a GitHub login matching one of `DASHBOARD_ALLOWED_LOGINS` or
  org membership in `DASHBOARD_ALLOWED_ORGS`.
- **Backfill CLI** — `npm run backfill` seeds `repos` + `prs` from every
  installed repo so the dashboard isn't empty on first run.

### Quality of life
- **Confidence-tagged findings** — AI marks each finding `high` / `medium` / `low`;
  uncertain ones render with a `🤔` blockquote so reviewers can triage.
- **Whitespace-insensitive fingerprints** — comments survive re-indenting and
  trivial reflows; titles normalize before hashing so re-wording doesn't break
  cross-review dedup.
- **Recursive comment guard** — bot ignores its own comments at the webhook
  layer so the tips footer mentioning `@bot` doesn't trigger a self-reply loop.
- **Config from PR head** — `.diffsentry.yaml` is loaded from the PR's HEAD,
  not the default branch. Config edits take effect on the PR that introduces
  them.

## Setup

### 1. Create a GitHub App
1. **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Webhook URL: `https://yourdomain.com/webhook`.
3. Webhook secret: `openssl rand -hex 20`.
4. **Repository permissions**:
   - Pull requests: Read & write
   - Contents: Read & write
   - Issues: Read & write
   - Commit statuses: Read & write
5. **Subscribe to events**: Pull request, **Issues**, Issue comment, Pull request review comment.
6. Create the App, note the App ID, generate a private key (`.pem`).

### 2. Install the App
Open the App's page → Install App → select the repos you want reviewed.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. See the table at the bottom of this README.

### 4. Run

```bash
npm install
npm run build
npm start
```

Or with Docker:

```bash
docker compose up --build -d
```

Health check: `GET /health`. Webhook endpoint: `POST /webhook`. Default port `3005`.

## Per-repo configuration

Drop a `.diffsentry.yaml` in your repo root. The full template lives in
`.diffsentry.example.yaml` — every option is documented inline, including
`anti_patterns`, `license_header`, and the built-in pattern toggle. The file
is always loaded from the repository's **default branch**, so the config on
your default branch is authoritative for *every* PR — including PRs opened
from stale or feature branches that don't contain it. A `.diffsentry.yaml`
that exists only on a PR branch is ignored; merge it to the default branch
to make it take effect.

### Generating a tailored config with your coding agent

A generic config is fine; a repo-grounded one is much better. Paste the
prompt below into Claude Code (or any agent with shell + write access)
**inside your repo**. It will explore the codebase, then write a
`.diffsentry.yaml` whose `path_instructions`, `anti_patterns`, and
`pre_merge_checks` are tied to paths and patterns that actually exist —
not generic boilerplate.

Safe to re-run; it overwrites `.diffsentry.yaml` at the repo root. For
monorepos, add a line at the top of the prompt: *"This repo contains
multiple services under `services/*` — scope every rule to one service
path."* DiffSentry loads config from the PR head, so it's worth opening
the first PR as a draft and checking the walkthrough looks sane before
merging.

````text
You are generating a `.diffsentry.yaml` for THIS repository so that
DiffSentry's PR reviews are tailored to our code, not generic.

DiffSentry is an AI PR-review bot. Its per-repo config supports:

  reviews:
    profile: chill | assertive
    request_changes_workflow: bool
    high_level_summary: bool
    walkthrough: { enabled, collapse, changed_files_summary,
                   sequence_diagrams, estimate_effort,
                   suggested_labels, suggested_reviewers, poem }
    auto_review: { enabled, drafts, base_branches[regex],
                   labels[!exclude], ignore_title_keywords,
                   ignore_usernames, auto_incremental_review,
                   auto_pause_after_reviewed_commits }
    path_filters: [glob, !glob]            # !glob excludes
    path_instructions:                     # per-area review focus
      - { path: glob, instructions: text }
    pre_merge_checks:
      title:       { mode: off|warning|error, requirements: text }
      description: { mode: off|warning|error, requirements: text }
      custom_checks:
        - { name, mode, instructions }
    builtin_patterns: bool                 # perf/footgun heuristics
    anti_patterns:                         # regex-based custom rules
      - { name, pattern, flags?, severity: critical|major|minor|trivial,
          type: issue|suggestion|nitpick|documentation|security,
          message, advice, path? }
    license_header:
      required: |
        <required header text>
      paths: [glob]
  chat:   { auto_reply: bool }
  issues: { auto_summary: { enabled, on_edit }, chat: { auto_reply } }

Anti-pattern regex notes:
  - Tested against ADDED lines only, multiline=false.
  - Use single quotes in YAML so backslashes aren't double-escaped.
  - Keep patterns specific — avoid \w+ catchalls that fire on noise.

YOUR TASK
=========

1. DETECT the stack first. Run `rg --files | head -200` and `ls -la`,
   look at package manifests (package.json, pyproject.toml,
   requirements*.txt, go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle,
   composer.json, mix.exs, etc.), and identify the language(s),
   framework(s), test runner, ORM/DB layer, logger, and CI setup.

2. EXPLORE to ground every rule in reality. Adapt these probes to the
   stack you detected — skip what doesn't apply, add what does:

   Layout:
     - `rg --files | head -200`, `ls -la`
     - Top-level dirs that hold real source vs generated/vendored output.

   Entry points & HTTP surface (pick the relevant ones):
     - Flask/Django/FastAPI/Express/Rails/Nest/etc. — find the app factory
       and route declarations.
     - CLI entry points, worker entry points, cron handlers.

   Data layer:
     - ORM usage (SQLAlchemy, Prisma, TypeORM, ActiveRecord, GORM, ...).
     - Migrations directory if one exists.
     - Raw SQL: `rg -n "execute\(\s*[\"'`]|\.query\(\s*[\"'`]"`.

   Auth & security surfaces:
     - login/session/JWT helpers, middleware, decorators.
     - CORS / CSRF setup.
     - Subprocess use: `rg -n "subprocess\.|os\.system\(|child_process|exec\("`.
     - Deserialization: `rg -n "pickle\.loads?\(|yaml\.load\(|eval\("`.
     - Templates with autoescape off / `|safe` / `dangerouslySetInnerHTML`.

   Outbound calls:
     - HTTP clients: `rg -n "requests\.|httpx\.|fetch\(|axios\.|http\.Get"`.
     - Look for missing timeouts / AbortSignal / context.WithTimeout.

   Logging & errors:
     - Detect the structured logger (pino, structlog, zap, logrus,
       app.logger, slf4j, ...). If one is in use, stray `print` / `console.log`
       in production code is an anti-pattern.
     - Empty catch / except-pass blocks.

   Config:
     - How secrets are loaded (env, vault, k8s secret). Flag literal
       secrets / API keys / SECRET_KEY committed in source.
     - Debug flags committed (`debug=True`, `NODE_ENV` checks, etc.).

   Tests & CI:
     - Test runner + structure.
     - CI workflows under `.github/workflows`, `.gitlab-ci.yml`, etc.

   Repo signals:
     - `git log --pretty='%an' --since='90 days ago' | sort -u` —
       contributor count.
     - `git log --oneline -50` — commit style (Conventional Commits?
       plain imperative? Sentence/lowercase?).
     - `git log --diff-filter=A --name-only --pretty='' | head -20 |
       xargs -I{} head -5 {}` — check if newly-added source files share
       a license header.

3. INFER from what you find. Examples of evidence-to-rule mapping:
   - Migrations dir exists → strict `path_instructions` for it.
   - Auth library in use → path rules emphasizing authz checks, session
     handling, token expiry on changed auth files.
   - ORM present → anti-pattern for string-interpolated SQL.
   - Templates with `|safe`, `Markup()`, `dangerouslySetInnerHTML` →
     security anti-pattern.
   - `subprocess.*shell=True` or template-literal `exec`/`spawn` →
     critical anti-pattern.
   - HTTP client calls without timeouts → major anti-pattern.
   - Committed `debug=True` / literal SECRET_KEY → critical.
   - Structured logger in use → anti-pattern for stray `print` / `console.*`
     in production code (scope to non-CLI paths).
   - Forward-only migrations or hand-maintained schema → `pre_merge_checks`
     custom check for "bump version, don't edit in place".
   - Multiple language SDKs (e.g. anthropic + openai) → parity check.

4. WRITE `.diffsentry.yaml` at the repo root. Requirements:
   - Use real module paths from THIS repo. If a path doesn't exist,
     omit the rule.
   - At least 6 `path_instructions` entries covering the actual
     top-level areas you found (routes, models, services, migrations,
     templates, tests, scripts, config — whichever apply).
   - At least 8 `anti_patterns`, each grounded in something real in
     the codebase. Each MUST include `name`, `pattern`, `severity`,
     `message`, `advice`, and `path` glob when scope-limited.
   - Set `auto_review.ignore_usernames` to include `dependabot[bot]` and
     `renovate[bot]` only if those bots actually open PRs (check
     `git log --pretty='%an' | sort -u | head -50`).
   - Set `path_filters` to exclude vendored / generated dirs you found
     (e.g. `dist/**`, `build/**`, `**/*.min.*`, `**/*.map`, `coverage/**`,
     `htmlcov/**`, `.venv/**`, `vendor/**`, lockfiles). Do NOT exclude
     real source.
   - Set `pre_merge_checks.title` and `.description` to match the
     observed commit style.
   - If newly-added source files share an identical license/copyright
     header, set `license_header.required` to that exact text and
     `paths` to where it applies. Otherwise omit the block.
   - Default `profile: assertive` if the repo is large (>500 source
     files OR >10 contributors in the last 90 days), else `chill`.
   - Leave inline `#` comments above each non-obvious block explaining
     WHY that rule exists for THIS repo (cite the file or pattern you
     saw). Reviewers read this on PRs.
   - VALIDATE before finishing: parse the YAML, and compile every
     anti-pattern regex (e.g. `node -e "..."` with js-yaml + new RegExp,
     or `python -c "..."` with PyYAML + re.compile). Fix anything that
     doesn't load.

5. AFTER WRITING, print a short summary:
   - How many path_instructions / anti_patterns you wrote.
   - The top 3 risk areas you identified.
   - Anything you wanted to add but skipped because the evidence wasn't
     strong enough (so the maintainer can decide whether to enable it
     manually).

Do not invent paths or rules you can't point to a file or grep hit for.
A small precise config beats a big speculative one.
````

## End-to-end test harness

`tests/e2e/` is a real-PR harness. Each scenario opens a PR on a sandbox
repo, polls for the bot's output, captures every review / inline comment /
status / issue comment, and writes a transcript.

```bash
npm run e2e -- --list           # list scenarios
npm run e2e -- divide-by-zero   # one scenario
npm run e2e -- --all            # full suite
```

Reports land in `tests/e2e/runs/<timestamp>_<scenario>/transcript.md`.

Reference data captured from CodeRabbit (`jasonkneen/codesurf#5`) lives in
`tests/e2e/reference/` along with `CODERABBIT-FORMAT.md`, the parity rubric
that maps each CR surface to the DiffSentry source location that produces it.

## Architecture

```
GitHub webhook
      │
      ▼
  server.ts            Express, signature verification, webhook routing,
                       bot-author filtering, Finishing-Touches checkbox
                       click handler.
      │
      ▼
  reviewer.ts          Orchestrator. Loads config from PR HEAD, fetches
                       PR context, runs safety + pattern scanners, calls
                       AI for review + walkthrough, computes insights,
                       composes the walkthrough + review-body, posts
                       everything, persists state in the walkthrough blob.
      │
      ├── repo-config.ts          .diffsentry.yaml loading + defaults
      ├── guidelines.ts           CLAUDE.md / AGENTS.md / .cursorrules auto-detect
      ├── issues.ts               'fixes #N' parsing + linked-issue fetch
      ├── issue-commands.ts       Issue @-mention command parsing + help text
      ├── learnings.ts            Per-repo learnings store
      ├── commands.ts             @mention command parsing + help text
      ├── walkthrough.ts          Walkthrough renderer (cohorts, effort, etc.)
      ├── walkthrough-state.ts    Base64-gzip-JSON state blob (file shas,
      │                           fingerprints, risk history) round-trip
      ├── review-body.ts          CodeRabbit-style review summary composer
      ├── sticky-status.ts        📌 pinned status comment + sparkline renderer
      ├── pre-merge.ts            Pre-merge checks (embedded sibling block)
      ├── finishing-touches.ts    docstring/test/simplify/autofix codegen
      ├── insights.ts             Risk Assessment, Test Coverage Signal,
      │                           confidence aggregate, reviewer-delta,
      │                           PR Split heuristic
      ├── safety-scanner.ts       Secret + merge-marker detectors
      ├── pattern-checks.ts       Built-in heuristics (perf, a11y, i18n) +
      │                           user anti_patterns
      ├── dep-scanner.ts          Manifest diff parser (npm/py/rust/go/ruby)
      ├── drift.ts                Description drift, commit coach, title
      │                           coach, license header
      ├── blame-reviewers.ts      git-blame-based reviewer suggestions
      ├── codeowners.ts           CODEOWNERS parser + per-file owner match
      ├── cross-pr.ts             Cross-PR thread memory + diff-PR helper
      ├── ai/prompt.ts               Prompt engineering (review + walkthrough)
      ├── ai/parse.ts                AI response parsing + inline-comment renderer
      ├── ai/anthropic.ts            Claude provider
      ├── ai/openai.ts               OpenAI provider
      └── ai/openai-compatible.ts    Local / self-hosted OpenAI-compatible provider
                                     (Ollama, LM Studio, vLLM, llama.cpp, LocalAI, ...)
      │
      ▼
  github.ts            GitHub API client (REST + GraphQL)
```

## Webhook events handled

| Event | Action | Behavior |
|---|---|---|
| `pull_request` | `opened` | Full review + walkthrough |
| `pull_request` | `synchronize` | Incremental review (uses state blob to skip unchanged files) |
| `pull_request` | `ready_for_review` | Full review (draft → ready) |
| `pull_request` | `closed` | Abort in-flight review |
| `issues` | `opened` / `reopened` | Auto-summary triage comment on the issue |
| `issue_comment` | `created` (on a PR) | `@bot` chat commands |
| `issue_comment` | `created` (on an issue) | `@bot` issue commands (summary / plan / chat / pause / resume / learn) |
| `issue_comment` | `edited` | Finishing-Touches checkbox click handler |
| `pull_request_review_comment` | `created` | `@bot` chat commands on review threads |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | Yes* | `./private-key.pem` | Path to the private key file |
| `GITHUB_PRIVATE_KEY` | Yes* | | Private key contents (alternative to PATH) |
| `GITHUB_WEBHOOK_SECRET` | Yes | | Webhook signature secret |
| `AI_PROVIDER` | No | `anthropic` | `anthropic`, `openai`, or `openai-compatible` |
| `ANTHROPIC_API_KEY` | If anthropic | | Anthropic API key |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Anthropic model |
| `ANTHROPIC_BASE_URL` | No | | Override Anthropic API base URL |
| `OPENAI_API_KEY` | If openai | | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-4o` | OpenAI model |
| `OPENAI_BASE_URL` | No | | Override OpenAI API base URL |
| `LOCAL_AI_BASE_URL` | If openai-compatible | | OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1` for Ollama). See [Using local models](#using-local-models-ollama-lm-studio-vllm-llamacpp-localai). |
| `LOCAL_AI_MODEL` | If openai-compatible | | Model name as exposed by the local server (e.g. `llama3.1:70b`, `qwen2.5-coder:32b`, `Qwen/Qwen2.5-Coder-32B-Instruct`). |
| `LOCAL_AI_API_KEY` | No | `not-needed` | API key. Most local servers ignore it; set it only when your backend enforces one (e.g. a hosted vLLM gateway). |
| `LOCAL_AI_JSON_MODE` | No | `true` | Send `response_format: json_object`. Set to `false` if your backend rejects the field (some older llama.cpp / vLLM builds). |
| `PORT` | No | `3005` | Server port |
| `LOG_LEVEL` | No | `info` | Logging level (runtime-overridable from the admin Settings page) |
| `MAX_FILES_PER_REVIEW` | No | `50` | Max files per review (runtime-overridable per-global/-repo from Settings) |
| `IGNORED_PATTERNS` | No | | Comma-separated globs to skip |
| `BOT_NAME` | No | `diffsentry` | Bot mention name for chat commands |
| `LEARNINGS_DIR` | No | `./data/learnings` | Per-repo learnings storage |
| `DB_PATH` | No | `./data/diffsentry.db` | SQLite file. Set to `""` to disable persistence (dashboard becomes empty). |
| `ENABLE_DASHBOARD` | No | | Set to `1` to mount the read-only command-center SPA at `/`, its JSON API at `/api/v1`, and the legacy dashboard at `/dashboard`. Off by default. |
| `DASHBOARD_URL` | If dashboard auth | | Full URL the dashboard is reachable at (e.g. `https://diffsentry.example.com/dashboard`). Used to build the OAuth callback. |
| `GITHUB_OAUTH_CLIENT_ID` | If dashboard auth | | GitHub App's OAuth client ID (on the App's General tab). |
| `GITHUB_OAUTH_CLIENT_SECRET` | If dashboard auth | | GitHub App's OAuth client secret. |
| `DASHBOARD_ALLOWED_LOGINS` | One of logins/orgs required | | Comma-separated GitHub user logins allowed to sign in (granted the `viewer` role by default). |
| `DASHBOARD_ALLOWED_ORGS` | One of logins/orgs required | | Comma-separated GitHub org slugs whose members may sign in (granted `viewer`). |
| `DASHBOARD_ADMIN_LOGINS` | No | | Comma-separated logins granted the `admin` role. |
| `DASHBOARD_AUTHOR_LOGINS` | No | | Comma-separated logins granted the `author` role. |
| `DASHBOARD_SESSION_SECRET` | No | `GITHUB_WEBHOOK_SECRET` | HMAC key for the dashboard session + CSRF cookies. |
| `DASHBOARD_SSE_HEARTBEAT_MS` | No | `25000` | Heartbeat interval (ms, min 1000) for the `/api/v1/stream` SSE feed. |
| `NOTIFY_SMTP_HOST` | If email channel | | SMTP server host for the email notification channel. Email channels are disabled until this and `NOTIFY_SMTP_FROM` are set. |
| `NOTIFY_SMTP_PORT` | No | `587` | SMTP port. `465` implies implicit TLS; `587`/`25` use STARTTLS when offered. |
| `NOTIFY_SMTP_FROM` | If email channel | | "From" address for notification emails. |
| `NOTIFY_SMTP_USER` | No | | SMTP username (AUTH LOGIN/PLAIN). Omit for unauthenticated relays. |
| `NOTIFY_SMTP_PASS` | No | | SMTP password. |
| `NOTIFY_SMTP_SECURE` | No | `false` | Force implicit TLS from the first byte (auto-on when port is 465). |
| `NOTIFY_DIGEST_DAY` | No | `1` | UTC weekday (0=Sun…6=Sat) the weekly digest is sent. |
| `NOTIFY_DIGEST_HOUR` | No | `9` | UTC hour (0–23) the weekly digest is sent. |
| `NOTIFY_DIGEST_DISABLED` | No | | Set to `1` to disable the scheduled weekly digest entirely. |
| `NOTIFY_ALLOW_INSECURE_WEBHOOKS` | No | | Permit plain `http://` webhook/Slack/Discord channel URLs (scheme only). Off by default — `https` required. Does **not** by itself allow private targets. |
| `NOTIFY_ALLOW_PRIVATE_WEBHOOKS` | No | | Permit webhook URLs that target (or resolve to) loopback/private/link-local/reserved addresses — separate, explicit SSRF opt-in for self-hosted internal relays. Off by default. |
| `DASHBOARD_INSTANCE_NAME` | No | `DiffSentry` | Default instance name (sidebar wordmark + tab title). An admin can override it live in Settings → Branding. |
| `DASHBOARD_ACCENT_COLOR` | No | `#5a8dff` | Default brand accent (hex `#rgb`/`#rrggbb`) the whole UI derives its accent from. Overridable live by an admin. |
| `DIFFSENTRY_SUPPRESS_DISMISSED` | No | | Set to `1` so new reviews drop findings whose fingerprint was dismissed or is currently snoozed via triage. Off by default — triage never changes review output unless enabled. |
| `DASHBOARD_CONFIG_PR_BRANCH_PREFIX` | No | `diffsentry/config` | Branch-name prefix used when an admin edits `.diffsentry.yaml` from the dashboard and chooses "open a PR". |
| `IMPACT_MINUTES_PER_FINDING` | No | `15` | Reviewer-minutes-saved-per-finding heuristic for the Impact report's time-saved estimate. The only estimated figure on that page; all other numbers are counted from the raw tables. |

\* One of `GITHUB_PRIVATE_KEY_PATH` or `GITHUB_PRIVATE_KEY` is required.

\*\* `ENABLE_DASHBOARD=1` alone runs the dashboard with no auth and logs a loud warning — only acceptable when the server is not internet-reachable. For public deployments all four dashboard-auth rows must be set, and at least one of `DASHBOARD_ALLOWED_LOGINS` / `DASHBOARD_ALLOWED_ORGS` must be non-empty.

**Auto-ignored files:** lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`),
minified assets (`*.min.js`, `*.min.css`), sourcemaps (`*.map`), build output
(`dist/**`, `build/**`, `.next/**`).

## Using local models (Ollama, LM Studio, vLLM, llama.cpp, LocalAI)

DiffSentry can talk to any server that exposes an **OpenAI-compatible
`/v1/chat/completions` endpoint**. In practice that covers every popular local
inference runtime. Set `AI_PROVIDER=openai-compatible` and point
`LOCAL_AI_BASE_URL` at the server.

**Model guidance.** DiffSentry's reviewer prompt asks for a structured JSON
object with inline comments bound to diff lines. That rules out small/chatty
models. Use a capable instruction-tuned model (32B+ params) that handles JSON
output well — e.g. Llama 3.1 70B Instruct, Qwen2.5-Coder 32B, DeepSeek-Coder
V2, Mixtral 8x22B. If comments come back empty or malformed, your model is
too small or ignoring the JSON instruction.

### Ollama

```bash
# 1. Install and pull a model
ollama pull llama3.1:70b

# 2. DiffSentry env
AI_PROVIDER=openai-compatible
LOCAL_AI_BASE_URL=http://localhost:11434/v1
LOCAL_AI_MODEL=llama3.1:70b
# LOCAL_AI_API_KEY and LOCAL_AI_JSON_MODE can be left default
```

Ollama honors `response_format: json_object` on recent versions — leave
`LOCAL_AI_JSON_MODE=true`. If you're running DiffSentry in Docker against an
Ollama instance on the host, use `http://host.docker.internal:11434/v1` (macOS
/ Windows) or the host's LAN IP on Linux.

### LM Studio

1. In LM Studio, load a model and click **Start Server** (default port `1234`).
2. DiffSentry env:
   ```bash
   AI_PROVIDER=openai-compatible
   LOCAL_AI_BASE_URL=http://localhost:1234/v1
   LOCAL_AI_MODEL=<the model id shown in LM Studio's server panel>
   ```
LM Studio exposes the model's full local identifier — copy it verbatim from
the server page. JSON mode works on LM Studio ≥ 0.3; if you see HTTP 400 from
`response_format`, set `LOCAL_AI_JSON_MODE=false`.

### vLLM

```bash
# Serve any HF model with an OpenAI-compatible API
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-32B-Instruct \
  --port 8000
```

```bash
AI_PROVIDER=openai-compatible
LOCAL_AI_BASE_URL=http://localhost:8000/v1
LOCAL_AI_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct   # must match --model exactly
# LOCAL_AI_API_KEY=...   # only needed if you launched vLLM with --api-key
```

vLLM supports `response_format: json_object` via its `--guided-decoding-backend`
flag on recent builds. Older builds may reject the field — set
`LOCAL_AI_JSON_MODE=false` in that case; DiffSentry's response parser
tolerates raw / fenced JSON.

### llama.cpp server (`llama-server`)

```bash
llama-server -m /path/to/model.gguf --host 0.0.0.0 --port 8080 \
  --chat-template llama3   # pick the template that matches your model
```

```bash
AI_PROVIDER=openai-compatible
LOCAL_AI_BASE_URL=http://localhost:8080/v1
LOCAL_AI_MODEL=local                             # llama.cpp ignores model name
LOCAL_AI_JSON_MODE=false                         # llama-server uses grammars instead
```

`llama-server` historically ignores `response_format`; DiffSentry's tolerant
JSON parser handles the plain-text JSON it returns. If your model drifts from
pure JSON, lower `temperature` via the server's CLI flags.

### LocalAI

```bash
AI_PROVIDER=openai-compatible
LOCAL_AI_BASE_URL=http://localhost:8080/v1
LOCAL_AI_MODEL=<model name from your LocalAI models.yaml>
```

### Any other OpenAI-compatible provider

The same settings work for Together, Groq, Fireworks, OpenRouter, DeepInfra,
Azure OpenAI's v1 endpoint, self-hosted proxies, etc. Set
`LOCAL_AI_BASE_URL` to the `/v1` URL, `LOCAL_AI_MODEL` to the provider's
model name, and `LOCAL_AI_API_KEY` if the provider requires one.

### Troubleshooting

- **HTTP 400 on reviews, 200 on chat** — your backend is rejecting
  `response_format: json_object`. Set `LOCAL_AI_JSON_MODE=false`.
- **Review summary renders but no inline comments** — the model isn't returning
  a `comments: [...]` array. Either the model is too small, or it's wrapping
  JSON in prose; try a stronger model or lower temperature.
- **`ECONNREFUSED` from Docker** — the container can't reach `localhost`. Use
  `host.docker.internal` (Desktop) or the host's LAN IP (Linux).
- **Very slow first review** — local models are slower than hosted ones. Use
  `MAX_FILES_PER_REVIEW` to cap per-PR cost, and consider a smaller model for
  chat (currently not independently configurable — PRs welcome).

## Development workflow

The full edit → push → redeploy → test loop (sandbox repo, redeploy
script, e2e harness, persistent SQLite inspection) is documented at
[`docs/E2E-DEPLOY-LOOP.md`](docs/E2E-DEPLOY-LOOP.md). Use that doc when
iterating on bot behavior — it covers the local-only files you need to
create (`scripts/local/redeploy.sh`), how the harness exercises real PRs,
and the gotchas that have bitten us.

## Web dashboard

The dashboard ships in-process alongside the webhook server — same container,
same port. It is being migrated from a server-rendered surface to an API-first
**Vite + React SPA** (the "command center"). During the transition both run
side by side:

- **`/` — the SPA** (new). A typed JSON API at **`/api/v1`** feeds a React +
  TanStack Query app built from `web/`. This is the surface under active
  development.
- **`/dashboard` — legacy server-rendered pages** (kept until the SPA reaches
  full parity, then removed in a cleanup PR).

The SPA is a static bundle (`web/dist`) served by the same Express process — no
second service, no extra port in production. The webhook path and behavior are
untouched.

**SPA pages** (all read-only)

- `/` — role-aware landing: **admins** drop into the live Ops Console, everyone
  else lands on the repos overview.
- `/ops` — **Ops Console**: a live, filterable tail of everything the bot is
  doing. Backfills from `GET /api/v1/activity` (events + reviews unified,
  cursor-paginated) then live-tails the SSE bus (`review.*`, `webhook.*`,
  `action.performed`). Auto-scrolls to the tail (pauses on hover), filters by
  repo / kind / severity, colour-codes each row by event type, shows an
  events-per-minute sparkline + SSE connection indicator, and deep-links each
  row to its PR.
- `/overview` — repos overview (PRs reviewed, 7d findings, 7d critical, last
  review), sortable, with a 14-day aggregate activity chart.
- `/queue` — the live **review pipeline board**: Queued → Running → Done /
  Failed lanes with per-card elapsed timers, a cancel button on in-flight
  reviews, and a one-click retry on the failed lane. Hydrates from
  `GET /api/v1/queue` then updates live from the `queue.updated` SSE stream.
- `/repos/:owner/:repo` — 90-day risk line, hot paths, top firing pattern
  rules, recent PRs + issues, active `@bot learn` learnings, the live
  `.diffsentry.yaml` for the repo, and (admin) a per-repo **operator overrides**
  card (auto-review / profile / max files).
- `/repos/:owner/:repo/pr/:number` — latest review snapshot, full findings
  table, all-reviews list, events timeline, link back to GitHub.
- `/findings` — cross-repo filterable explorer (severity, source, repo,
  free-text, age, **triage state**) with inline + bulk **triage** controls
  (accept / dismiss / snooze-with-date + note) and a recurring-fingerprints group.
- `/findings/recurring` — fingerprints ranked by how often they reappear, with a
  per-class triage rollup and one-click accept/dismiss of a whole class.
- `/patterns` — every pattern-rule hit with 30d + all-time counts.
- `/cost` — AI spend: spend-over-time stacked by model, top repositories,
  tokens-vs-dollars per model, month-to-date + projected month-end, and a budget
  gauge per scope (admins can set/clear monthly ceilings inline).
- `/rules` — **admin only** — author custom anti-pattern rules (name, severity,
  scope, regex, optional path glob, message/advice). A live tester runs the
  pattern against a pasted snippet and highlights matches without persisting,
  and the active-rules table joins each rule to its pattern-hit counts.
- `/leaderboard` — per-author review activity over a 7/30/90-day window
  (PRs reviewed, avg risk, findings/PR by severity, acceptance rate, trend
  sparkline), sortable, with a click-through author drill-down (severity mix,
  hot paths, recent PRs). Framed as where review effort lands, not a scoreboard.
- `/trends` — org-wide activity over time, risk-level distribution, and
  hot-paths-over-time (top paths by critical+major with a per-path trend line).
- `/learnings` — manage the `@bot learn` learnings the reviewer applies:
  searchable list of global + per-repo learnings, inline edit, path-glob
  badges, create, bulk delete, dedupe suggestions, "promote to global", and a
  "test against a file path" preview. Reads are open to viewers; create/edit/
  delete require `author`.
- `/audit` — **admin only** — the audit trail (who did what, when) plus a
  per-login role-override editor.
- `/tokens` — **admin only** — create / list / revoke platform API tokens
  (the secret is shown once), with a link to the rendered API docs.
- `/webhooks` — **admin only** — every raw webhook delivery GitHub sent
  (event, repo, signature status, size), with an expandable syntax-highlighted
  JSON viewer and a one-click **Replay** that re-runs the stored payload through
  the engine. Filter by event type and repo.
- `/settings` — (admin) **operator controls**: a prominent global **Pause-All**
  kill switch with live status, plus grouped review defaults (auto-review,
  default profile, log level, max files). Also runtime + storage health, the
  signed-in session with its resolved role + capabilities, and a recent
  warn/error log tail captured via an in-process pino ring buffer.
- `/settings/diagnostics` — the **guided first-run / health screen**: per-area
  configuration checks (GitHub App, AI provider, dashboard auth, persistence)
  each with a concrete fix hint, an on-demand **GitHub App probe** (which
  installations + repos are connected, recent webhook delivery outcomes, and
  rate-limit headroom), and one-click **test AI call** + **test webhook secret**
  self-tests. When any check fails, a dismissible **setup wizard** banner
  appears app-wide pointing to exactly what's missing.

**Command palette (⌘K / Ctrl-K)** — press `⌘K` anywhere (or click **Search…**
in the sidebar) to open a keyboard-first palette that combines three things:

- **Navigation** — jump to any screen (capability-filtered, so non-admins don't
  see the Audit entry).
- **Quick actions** — when you're on a PR page, the author+ commands
  (re-review, resolve threads, pause/resume, cancel) are one keystroke away.
  They run through the same `requireRole` + CSRF + audit + SSE command endpoints
  as the on-page buttons, so they're hidden for viewers and audited for everyone
  else.
- **Search** — `GET /api/v1/search?q=` does a ranked `LIKE` sweep across repos,
  PRs, findings, and on-disk learnings; each result deep-links to its screen.
  `↑`/`↓` move, `↵` opens/acts, `esc` closes.

**JSON API** (`/api/v1`)

failure. Read endpoints: `GET /me`, `/health`, `/queue`, `/repos`,
`/repos/:owner/:repo`, `/repos/:owner/:repo/prs/:number`,
`/repos/:owner/:repo/config`, `/findings`, `/findings/recurring`, `/patterns`,
`/activity` (unified events+reviews feed; `?repo=&kind=&severity=&before=&limit=`), `/cost`
(`?range=7d|30d|90d|mtd&group=repo|model|day|kind`), `/rules` (admin),
`/search?q=`, the analytics trio `/analytics/authors`,
`/analytics/authors/:author`, `/analytics/trends` (all accept `?days=`, default
30, clamped 1–365), `/audit` (admin), `/tokens` (admin), `/webhooks` +
`/webhooks/:id` (admin), `/diagnostics` (static config + DB checks), and
`/diagnostics/github` (live App probe). The machine-readable
**`GET /api/v1/openapi.json`** (OpenAPI 3) and the rendered docs page
**`GET /api/v1/docs`** are public. `GET /queue` returns the live review-pipeline
snapshot from an in-process registry (works regardless of persistence). Write
endpoints: `POST /roles` (admin) sets/clears a role override; `POST /cost/budget`
(admin) `{ scope, monthlyUsd }` sets/clears a monthly budget; `GET`/`POST /tokens`
+ `DELETE /tokens/:id` (admin) manage platform API tokens; `POST/PUT/DELETE /rules`
(admin) manage custom rules and `POST /rules/test` (admin) tests a candidate
pattern against a snippet without persisting; `PUT /repos/:owner/:repo/config`
(admin) edits `.diffsentry.yaml`; `POST /webhooks/:id/replay` (admin)
re-dispatches a stored delivery; `POST /diagnostics/test-ai` and `POST
/diagnostics/test-webhook` (both `author`+, CSRF + audited) run the provider
reachability and webhook-secret self-tests. When OAuth is configured every other
endpoint requires a valid session or bearer API token (401 JSON otherwise); the
queries reuse the same SQL as the legacy dashboard and no-op gracefully when
persistence is disabled.

**Webhook capture & replay.** Every delivery to `POST /webhook` is persisted to
`webhook_deliveries` (event, action, repo, PR/issue number, `X-GitHub-Delivery`
id, whether the signature verified, and a truncated payload) right after
signature verification — rejected deliveries are recorded too, so the inspection
view shows everything. `POST /webhooks/:id/replay` (admin + CSRF) records a new
delivery row flagged `replayed_from` and re-runs the stored payload through the
exact same engine path the live handler uses, then writes a `webhook.replay`
audit row and emits `webhook.replayed` over SSE. Replay never re-enters the
`/webhook` capture path, so it can't loop.

**First-run diagnostics & setup wizard.** `GET /diagnostics` reads the
environment (GitHub App, AI provider, OAuth, DB) and reports each as
`ok`/`warn`/`fail` with a fix hint — no network calls, so it's instant and
drives the wizard (`incomplete` when any check fails). `GET /diagnostics/github`
authenticates as the App (JWT) to enumerate installations + connected repos,
read the configured webhook URL and the last few delivery outcomes, and report
rate-limit headroom — so a misconfigured instance pinpoints whether the App is
even installed and whether GitHub's webhooks are reaching you. `test-ai` fires a
tiny completion at the configured provider (proving the key works), and
`test-webhook` confirms `GITHUB_WEBHOOK_SECRET` produces a valid HMAC signature
the verifier accepts. These reuse existing config and the review engine — **no
new environment variables** are introduced.

**Command actions** (`author`+) drive the review engine and findings triage from
the dashboard. Each is `requireRole('author')` + CSRF gated, writes an
`audit_log` row, and emits an SSE event:

| Endpoint | Effect |
|---|---|
| `POST /repos/:owner/:repo/prs/:number/review` `{ mode: 'full'\|'incremental' }` | Queue a (re-)review — returns `202`, runs in the background. |
| `POST .../prs/:number/resolve` | Resolve all DiffSentry review threads on the PR. |
| `POST .../prs/:number/pause` / `.../resume` | Pause / resume automatic + manual reviews. |
| `POST .../prs/:number/cancel` | Abort any in-flight review (handlePRClose semantics). |
| `POST .../prs/:number/command` `{ command }` | Run a chat command on the PR by synthesizing an `@bot <cmd>` through `handleComment` — returns `202`, runs in the background. `command` is allowlisted: `summary`, `tldr`, `ship`, `changelog`, `generate_tests`, `generate_docstrings`. |
| `POST /findings/:id/triage` `{ state, until?, note? }` | Triage one finding — `state` is `accepted`\|`dismissed`\|`snoozed` (snooze needs a future `until`). |
| `POST /findings/triage` `{ ids[]\|fingerprint, state, until?, note? }` | Bulk-triage many findings, or a whole fingerprint class at once. |

The PR-detail and repo-detail screens render an **action bar** wiring up these
endpoints — re-review (full/incremental), resolve/pause/resume/cancel, and the
chat commands as buttons. The repo screen's bar targets the most recent PR. The
whole write surface is hidden for viewers; each button shows a spinner +
optimistic toast and reports the audit-logged result.

**Triage feedback into reviews** is opt-in. Triage state always persists and is
visible in the UI + audit log, but reviews ignore it by default. Set
`DIFFSENTRY_SUPPRESS_DISMISSED=1` to have new reviews drop any finding whose
fingerprint is dismissed or currently snoozed — so the engine never changes its
output from triage data unless an operator explicitly enables it.

**Custom rules** (`admin`) extend the pattern engine from the UI. `POST /rules`,
`PUT /rules/:id`, and `DELETE /rules/:id` manage admin-authored anti-patterns
(stored in the `custom_rules` table, migration v3); each is `requireRole('admin')`
+ CSRF gated, writes an `audit_log` row, and publishes a `rule.changed` SSE event.
Enabled rules — global, or scoped to one `owner/repo` — compile into the review
engine alongside the built-ins and the `.diffsentry.yaml` `anti_patterns`, and
their hits are recorded with `source='custom'` so they show up in pattern
analytics. `POST /rules/test` compiles + runs a candidate pattern against a
pasted snippet (no persistence) for the live tester.

**Config editor** (`admin`) — edit a repo's `.diffsentry.yaml` from the dashboard
(`/repos/:owner/:repo/config`). `GET .../config` returns the current YAML on the
default branch, the parsed + merged-with-defaults effective config, and a JSON
schema derived from `RepoConfig`. The editor offers a **schema-aware form** and a
**raw YAML editor** (CodeMirror) kept in sync, with live validation and a
side-by-side diff preview. `PUT .../config` (admin + CSRF) validates the YAML
(syntax + schema — invalid configs are rejected with field-level errors before
anything is written) and then either **commits directly** to the default branch
or **opens a PR** (your choice). The change is audit-logged with a diff
(`config.update`) and announced on the bus as `config.updated`; a direct commit
also invalidates the 5-minute config read cache.

**Operator settings** (`admin`) are runtime overrides stored in the
`settings_overrides` table (not repo writes) — they layer on top of the
`.diffsentry.yaml` and the env defaults. Each write is `requireRole('admin')` +
CSRF gated, writes an `audit_log` row, and emits a `settings.changed` SSE event.

| Endpoint | Effect |
|---|---|
| `GET /api/v1/settings` | Resolved global settings (with defaults filled in). |
| `PUT /api/v1/settings` | Set/clear global overrides — any subset of keys; `null` clears a clearable one. |
| `GET /api/v1/repos/:owner/:repo/settings` | Per-repo overrides (`null` field = inherit global). |
| `PUT /api/v1/repos/:owner/:repo/settings` | Set/clear per-repo overrides. |

Keys and resolution (per-repo override **>** global default **>** file/env default):

| Key | Scope | Effect |
|---|---|---|
| `pauseAll` | global | **Kill switch.** When on, the webhook queues **no** new reviews (PR opened/synchronize/ready-for-review) and the engine skips any trigger — chat `@bot review` and dashboard triggers included. Push auto-resolve still runs. |
| `autoReview` | global + repo | Enable/disable **automatic** (webhook) reviews. A per-repo value wins over the global default (default `true`). |
| `defaultProfile` / `profile` | global / repo | Review profile (`chill` \| `assertive`); overrides the `.diffsentry.yaml` `reviews.profile`. |
| `logLevel` | global | Process log level — applied to the running logger immediately **and** re-applied on restart (overrides `LOG_LEVEL`). |
| `maxFiles` | global + repo | Cap on changed files sent to the model; overrides `MAX_FILES_PER_REVIEW`. Clear to revert to the env default. |

All reads no-op to the documented defaults when persistence is disabled, so the
controls degrade cleanly without a database.

**Realtime** (`GET /api/v1/stream`) is a Server-Sent Events feed on an in-process
event bus. The review engine publishes `review.started` / `review.finished` /
`review.failed`, every inbound GitHub webhook publishes `webhook.received`, the
in-memory review queue publishes `queue.updated` on every state transition
(queued → running → done/failed/canceled, including phase changes), every command
action publishes `action.performed`, a custom rule change publishes `rule.changed`,
a config edit publishes `config.updated`, a settings change publishes
`settings.changed`, a webhook replay publishes `webhook.replayed`, and the cost
instrumentation publishes `budget.exceeded` when month-to-date spend crosses a
configured ceiling. The SPA opens one `EventSource`, surfaces events as toasts,
streams them into the Ops Console, drives the live queue board, and live-refetches
the affected PR — so a re-review's findings appear without a refresh. The stream
heartbeats every `DASHBOARD_SSE_HEARTBEAT_MS` (default 25s) and replays missed
events on reconnect via `Last-Event-ID`.

**AI cost tracking**

Every provider call (Anthropic, OpenAI, or any OpenAI-compatible endpoint)
records its token usage and a computed USD cost to a `cost_events` row, tagged
with `owner/repo/number/review_id/kind` (`review`, `chat`, `finishing-touch`,
`issue`, …). Attribution is threaded through an `AsyncLocalStorage` context the
engine establishes around each unit of work, so concurrent reviews never
cross-attribute and the `AIProvider` interface is unchanged. During a review the
events are buffered and stamped with the `review_id` once the review row exists.

Cost is derived from a built-in per-model price table (USD per 1M input/output
tokens); override or extend it with `AI_MODEL_PRICES` (a JSON map of model id or
family prefix → `{ input, output }`). Unknown models still record tokens at a
zero cost until a price is added. **Budgets** are monthly USD ceilings per scope
(`global` or `owner/repo`), stored in `settings_overrides` and managed on the
Cost page; the first crossing within a month emits the `budget.exceeded` event
and writes an `audit_log` entry (deduped per scope/month).

**Platform API (bearer tokens)**

Beyond the cookie-session dashboard, the API accepts **bearer tokens** for
scripts and integrations. An admin mints tokens from the `/tokens` screen (or
`POST /api/v1/tokens`); the plaintext (`dsk_…`) is shown **once** and only its
SHA-256 hash is stored. Send it as `Authorization: Bearer dsk_…`:

```bash
curl -H "Authorization: Bearer dsk_xxx" https://your-host/api/v1/repos
```

Tokens carry **scopes**: `read` (every GET endpoint) and `review` (the safe
action subset — trigger reviews, resolve, pause/resume/cancel; implies `read`).
The gate enforces them per request — a `read`-only token gets `403` on any write,
and an unknown or revoked token gets `401`. Tokens **never** reach admin
endpoints (audit, role/token administration); those stay cookie-session +
`admin` only. Each authenticated call bumps the token's `last_used_at`, and
create/revoke land an `audit_log` row plus a `token.changed` SSE event. Bearer
requests are exempt from CSRF (there's no ambient cookie to forge); cookie
writes still require the `X-CSRF-Token` header.

Explore the full surface at **`/api/v1/docs`** (a dependency-free viewer that
renders **`/api/v1/openapi.json`**) — both are public.

**Mobile & offline (PWA)**

The SPA is responsive and installable — no extra service or env vars.

- **Responsive shell** — on phones the sidebar collapses into an off-canvas
  drawer opened from a sticky top bar (tap-out / Esc / route-change closes it),
  and data tables reflow into stacked cards (each cell labelled by its column).
- **Installable** — a web app manifest + maskable icons let it be added to the
  home screen / installed as a desktop app. It launches standalone on the dark
  theme.
- **Offline shell** — a service worker (generated by `vite-plugin-pwa`)
  precaches the built app shell and its fonts, so an offline launch shows a
  graceful cached UI instead of a browser error. A new build surfaces an
  "update available" prompt rather than reloading mid-action; an offline pill
  appears in the shell when the network drops.
- **Offline data, handled safely** — the service worker **never** caches
  `/api` responses, so authenticated data is never written to the shared
  Cache Storage. Offline "last-viewed data" instead comes from a TanStack Query
  cache persisted to `localStorage` that is **scoped to the signed-in login,
  busted when a different user signs in on the device, and purged on sign-out**.

The webhook path and behaviour are untouched, and the service worker is scoped
to skip `/api`, `/webhook`, `/dashboard`, `/health`, and `/stream`.

**Roles & access control (RBAC)**

Every signed-in user has a role — `viewer` < `author` < `admin`. A login's role
resolves with this precedence (first match wins):

1. **roles table** — a per-login override set from the Audit screen (`POST /roles`).
2. **`DASHBOARD_ADMIN_LOGINS`** env allowlist → `admin`.
3. **`DASHBOARD_AUTHOR_LOGINS`** env allowlist → `author`.
4. passed the sign-in allowlist (`DASHBOARD_ALLOWED_LOGINS` / `_ORGS`) → `viewer`.

`GET /api/v1/me` returns `{ login, id, role, capabilities }`; the SPA fetches it
once into an auth context and hides/disables controls a role can't use. Each
capability is **also** enforced server-side — write endpoints are wrapped in
`requireRole(...)` (JSON 403 on failure), so hiding a button is a convenience,
never the security boundary. Cookie-authenticated writes carry the `ds_csrf`
double-submit token as an `X-CSRF-Token` header.

| Capability | viewer | author | admin |
|---|:--:|:--:|:--:|
| View dashboard & findings | ✅ | ✅ | ✅ |
| Triage findings | — | ✅ | ✅ |
| Trigger reviews | — | ✅ | ✅ |
| Manage learnings | — | ✅ | ✅ |
| Manage config | — | — | ✅ |
| Manage role overrides | — | — | ✅ |
| View audit log | — | — | ✅ |
| Manage notifications | — | — | ✅ |
| Manage API tokens | — | — | ✅ |

When OAuth is disabled (open/local mode) there is no session to gate on, so the
local operator is treated as `admin`.

**Notifications** (admin) push DiffSentry signal off the dashboard. Configure
delivery **channels** and **alert rules** on the Notifications screen:

- **Channels** — Slack incoming webhook, Discord webhook, a generic JSON webhook,
  or email (SMTP via the `NOTIFY_SMTP_*` env vars). Secrets are masked after save.
- **Rules** — route an event to a channel, optionally scoped to one `owner/repo`.
  Events: `finding` (with a minimum-severity floor — e.g. "critical finding in
  repo X"), `review_failed`, `budget` (the cost feature's `budget.exceeded`, when
  a monthly budget set on the Cost page is crossed), and `digest`. The alert
  engine subscribes to the in-process bus, so a matching event delivers a real
  message immediately.
- **Weekly digest** — a `digest` rule sends a per-channel ROI rollup (reviews,
  findings by severity, top repos) once a week (`NOTIFY_DIGEST_DAY` /
  `NOTIFY_DIGEST_HOUR`, UTC; persisted so restarts don't double-send).
- **Send test** — every channel has a one-click test send; **recent deliveries**
  (rule-, digest-, and test-driven) are listed with status + detail.

Each write follows the command-center contract (`requireRole('admin')` + CSRF +
`audit_log` + a `config.changed` SSE event). Endpoints live under
`/api/v1/notifications` (`GET` everything; `POST`/`PUT`/`DELETE` for channels and
rules; `POST .../channels/:id/test`). Verified by `npm run smoke:notifications`.

**Theming & branding**

The UI is fully themed via CSS variables. Each user picks their own **theme**
(dark — the default — light, or follow the OS) and **density** (comfortable /
compact) in Settings → Appearance; the choice is stored in that browser's
`localStorage` and applied by a tiny inline script before first paint, so
reloads and theme switches never flash. A quick dark⇄light toggle also lives in
the sidebar.

Admins (the `Manage config` capability) can set an instance-wide **name** and
**accent color** in Settings → Branding (`GET`/`POST /api/v1/settings/branding`).
The accent recolors the whole app, and a change broadcasts a `settings.updated`
SSE event so every open dashboard re-brands live. Branding resolves
admin override (SQLite) → `DASHBOARD_INSTANCE_NAME` / `DASHBOARD_ACCENT_COLOR`
env → built-in `DiffSentry` / `#5a8dff`, and persistence is optional (with the
DB off, the env/built-in defaults apply and writes no-op).

**Local development**

The backend serves the API on port **3005**; the SPA runs on the Vite dev
server with a proxy so `/api` calls hit the backend (single-origin cookies just
work):

```bash
# Terminal 1 — backend (API + webhook) with live reload
ENABLE_DASHBOARD=1 npm run dev          # http://localhost:3005

# Terminal 2 — SPA dev server (proxies /api → :3005)
npm run dev:web                         # http://localhost:5174
```

Build everything for production with `npm run build` (compiles the server **and**
runs `vite build` into `web/dist`). `npm run build:web` builds just the SPA.
In Docker the multi-stage `Dockerfile` builds the SPA, builds the server, and
copies `web/dist` into the runtime image — still one container.

**Enabling**

The dashboard is off by default. Set `ENABLE_DASHBOARD=1` to mount it, then
configure OAuth so it isn't publicly reachable:

```
ENABLE_DASHBOARD=1
DASHBOARD_URL=https://diffsentry.example.com/dashboard
GITHUB_OAUTH_CLIENT_ID=…   # from the GitHub App's OAuth config
GITHUB_OAUTH_CLIENT_SECRET=…
# At least one of the two allowlists. Either grants access.
DASHBOARD_ALLOWED_LOGINS=your-gh-login
DASHBOARD_ALLOWED_ORGS=your-org
# DASHBOARD_SESSION_SECRET — optional, defaults to GITHUB_WEBHOOK_SECRET
```

With `ENABLE_DASHBOARD=1` but no OAuth vars, the dashboard mounts in
"open" mode and logs a warning. Don't deploy that to a reachable server.

**Backfill**

Use `npm run backfill` to seed `prs` + events from existing PRs in every
installed repo so the dashboard isn't empty on first run. Accepts
`--repo owner/name` and `--limit N`.

**Smoke test**

`npm run smoke:dashboard` spins the dashboard against a temp SQLite and
verifies every route end-to-end (overview, repo detail, PR detail, findings
filters, patterns, settings, auth redirect).

## License

MIT
