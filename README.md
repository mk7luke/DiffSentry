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
is loaded from the PR's HEAD ref, so config changes self-test on the PR
that introduces them.

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
| `LOG_LEVEL` | No | `info` | Logging level |
| `MAX_FILES_PER_REVIEW` | No | `50` | Max files per review |
| `IGNORED_PATTERNS` | No | | Comma-separated globs to skip |
| `BOT_NAME` | No | `diffsentry` | Bot mention name for chat commands |
| `LEARNINGS_DIR` | No | `./data/learnings` | Per-repo learnings storage |
| `DB_PATH` | No | `./data/diffsentry.db` | SQLite file. Set to `""` to disable persistence (dashboard becomes empty). |
| `ENABLE_DASHBOARD` | No | | Set to `1` to mount the read-only dashboard at `/dashboard`. Off by default. |
| `DASHBOARD_URL` | If dashboard auth | | Full URL the dashboard is reachable at (e.g. `https://diffsentry.example.com/dashboard`). Used to build the OAuth callback. |
| `GITHUB_OAUTH_CLIENT_ID` | If dashboard auth | | GitHub App's OAuth client ID (on the App's General tab). |
| `GITHUB_OAUTH_CLIENT_SECRET` | If dashboard auth | | GitHub App's OAuth client secret. |
| `DASHBOARD_ALLOWED_LOGINS` | One of logins/orgs required | | Comma-separated GitHub user logins allowed to sign in. |
| `DASHBOARD_ALLOWED_ORGS` | One of logins/orgs required | | Comma-separated GitHub org slugs whose members may sign in. |
| `DASHBOARD_SESSION_SECRET` | No | `GITHUB_WEBHOOK_SECRET` | HMAC key for the dashboard session cookie. |

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

A read-only, server-rendered dashboard ships in-process alongside the webhook
server. Same container, same port. Scoped in
[`docs/PRD-web-dashboard.md`](docs/PRD-web-dashboard.md).

**Pages**

- `/dashboard` — repos overview (open PRs reviewed, 7d findings, 7d critical,
  last review), sortable.
- `/dashboard/repo/:owner/:repo` — 90-day risk sparkline, hot paths, top
  firing pattern rules, recent reviews, active `@bot learn` learnings, and
  the live `.diffsentry.yaml` for the repo.
- `/dashboard/repo/:owner/:repo/pr/:number` — latest review snapshot, full
  findings table, all-reviews list, events timeline, link back to GitHub.
- `/dashboard/findings` — cross-repo filterable explorer (severity, source,
  repo, free-text, age) with a "recurring fingerprints" group.
- `/dashboard/patterns` — every pattern-rule hit with 30d + all-time counts.
- `/dashboard/settings` — runtime + storage health, recent warn/error log
  tail captured via an in-process pino ring buffer.

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
