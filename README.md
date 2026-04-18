# DiffSentry

Self-hosted AI-powered GitHub pull request review bot. A comprehensive CodeRabbit alternative you own and control.

## Features

### Core Review
- **Automatic PR reviews** on open, push, and ready-for-review events
- **Inline comments** on specific lines with suggested fixes (`suggestion` blocks)
- **Comment categorization** — issues, suggestions, and nitpicks with severity levels (critical/major/minor/trivial)
- **Review profiles** — `chill` (critical issues only) or `assertive` (comprehensive feedback)
- **Incremental reviews** — only re-review new changes on subsequent pushes
- **Commit status checks** — sets GitHub commit status reflecting review state
- **Stale review dismissal** — auto-dismisses previous bot reviews

### Walkthrough & Summary
- **PR Walkthrough comment** — structured overview with:
  - Changed files table with AI-generated descriptions
  - Estimated review effort (1-5 scale)
  - Mermaid sequence diagrams
  - Suggested labels and reviewers
  - Related issues and PRs
  - Optional poem
- **PR description summary** — injects AI summary into the PR body (idempotent)
- **Auto-apply labels** — automatically applies suggested labels
- **Auto-assign reviewers** — automatically requests suggested reviewers

### Interactive Chat
Mention `@diffsentry` (or your configured bot name) in any PR comment:

| Command | Description |
|---------|-------------|
| `@bot review` | Trigger an incremental review |
| `@bot full review` | Trigger a full review of all files |
| `@bot pause` | Pause automatic reviews on this PR |
| `@bot resume` | Resume automatic reviews |
| `@bot resolve` | Resolve all review comment threads |
| `@bot summary` | Regenerate the walkthrough and PR summary |
| `@bot configuration` | Show active configuration |
| `@bot help` | Show all available commands |
| `@bot learn <text>` | Save a learning for future reviews |
| `@bot generate docstrings` | Add missing docstrings and commit to branch |
| `@bot generate tests` | Generate unit tests and commit to branch |
| `@bot simplify` | Simplify changed code and commit to branch |
| `@bot autofix` | Apply fixes from review comments and commit |

Any other `@bot` mention is treated as a free-form question about the PR.

### Finishing Touches (Code Generation)
- **Generate docstrings** — scans for undocumented functions, generates language-appropriate docstrings
- **Generate unit tests** — produces comprehensive tests with edge cases
- **Simplify code** — reduces complexity while preserving public APIs
- **Autofix** — implements fixes from unresolved review comments

All finishing touches commit directly to the PR branch.

### Knowledge Base
- **Learnings** — persistent per-repo memory from `@bot learn` commands, injected into future reviews
- **Code guidelines auto-detection** — automatically reads and applies:
  - `CLAUDE.md`, `AGENTS.md`, `AGENT.md`, `GEMINI.md`
  - `.cursorrules`, `.windsurfrules`
  - `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`
  - `.cursor/rules/*`, `.clinerules/*`, `.rules/*`
- **Linked issue context** — detects `fixes #123` / `closes #123` / `resolves #123` in PR descriptions, fetches issue content, and injects it into the review
- **Related PRs** — finds open PRs that touch the same files

### Pre-Merge Checks
- **PR title validation** — configurable requirements with warning/error modes
- **PR description validation** — ensures descriptions meet template requirements
- **Custom checks** — define validation rules in natural language, evaluated by AI
- Results posted as a comment and reflected in commit status

### Auto-Review Controls
- Filter by base branches (regex patterns)
- Filter by PR labels (with `!` prefix for exclusion)
- Skip draft PRs
- Ignore specific title keywords (e.g., `WIP`, `DO NOT MERGE`)
- Ignore specific authors (e.g., `dependabot[bot]`)
- Auto-pause after N reviewed commits
- Abort review when PR is closed

### Multi-Provider AI
- **Anthropic** (Claude) — default
- **OpenAI** (GPT-4o, o3, etc.)
- Configurable model per provider
- **Custom base URLs** — point at any OpenAI or Anthropic-compatible endpoint (Azure OpenAI, Ollama, vLLM, LiteLLM, etc.)

## Setup

### 1. Create a GitHub App

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. Set the **Webhook URL** to `https://yourdomain.com/webhook`
3. Set a **Webhook secret** (e.g. `openssl rand -hex 20`)
4. Under **Permissions > Repository permissions**:
   - **Pull requests**: Read & write
   - **Contents**: Read & write (needed for finishing touches, config loading)
   - **Issues**: Read & write (needed for linked issues, comments)
   - **Commit statuses**: Read & write
5. Under **Subscribe to events**: check **Pull request**, **Issue comment**, **Pull request review comment**
6. Click **Create GitHub App**, note the **App ID**
7. Under **Private keys**, generate and save the `.pem` file

### 2. Install the App

Go to your GitHub App's settings, click **Install App**, and select your repositories.

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values. See the [Environment Variables](#environment-variables) section below.

### 4. Run

**With Node.js:**
```bash
npm install
npm run build
npm start
```

**With Docker:**
```bash
docker-compose up --build
```

The server starts on port 3005 by default. Health check: `GET /health`. Webhook: `POST /webhook`.

## Per-Repository Configuration

Create a `.diffsentry.yaml` in your repository root. See `.diffsentry.example.yaml` for a fully documented template.

```yaml
# Review profile: "chill" (critical only) or "assertive" (comprehensive)
reviews:
  profile: "assertive"
  high_level_summary: true
  commit_status: true
  auto_apply_labels: true
  auto_assign_reviewers: false

  walkthrough:
    enabled: true
    collapse: true
    changed_files_summary: true
    sequence_diagrams: true
    estimate_effort: true
    poem: false

  auto_review:
    enabled: true
    drafts: false
    auto_incremental_review: true
    auto_pause_after_reviewed_commits: 10
    base_branches:
      - "main"
      - "develop"
    ignore_title_keywords:
      - "WIP"
      - "[skip review]"
    ignore_usernames:
      - "dependabot[bot]"
    labels:
      - "!do-not-review"

  path_filters:
    - "!dist/**"
    - "!**/*.generated.ts"
    - "src/**"

  path_instructions:
    - path: "src/api/**"
      instructions: |
        Focus on authentication, input validation, and error handling.
    - path: "tests/**"
      instructions: |
        Ensure test coverage for edge cases and error paths.

  pre_merge_checks:
    title:
      mode: "warning"
      requirements: "Start with an imperative verb; keep under 72 characters."
    description:
      mode: "error"
    custom_checks:
      - name: "No console.log"
        mode: "warning"
        instructions: "Fail if any changed file contains console.log statements."

# Review language (affects AI response language)
language: "en-US"

# Tone customization
tone_instructions: "Be encouraging but thorough."

chat:
  auto_reply: true
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | Yes* | `./private-key.pem` | Path to private key file |
| `GITHUB_PRIVATE_KEY` | Yes* | | Private key as string (alternative) |
| `GITHUB_WEBHOOK_SECRET` | Yes | | Webhook signature secret |
| `AI_PROVIDER` | No | `anthropic` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | If anthropic | | Anthropic API key |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Anthropic model |
| `ANTHROPIC_BASE_URL` | No | | Custom Anthropic-compatible API endpoint |
| `OPENAI_API_KEY` | If openai | | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-4o` | OpenAI model |
| `OPENAI_BASE_URL` | No | | Custom OpenAI-compatible API endpoint |
| `PORT` | No | `3005` | Server port |
| `LOG_LEVEL` | No | `info` | Logging level |
| `MAX_FILES_PER_REVIEW` | No | `50` | Max files per review |
| `IGNORED_PATTERNS` | No | | Comma-separated glob patterns to skip |
| `BOT_NAME` | No | `diffsentry` | Bot mention name for chat commands |
| `LEARNINGS_DIR` | No | `./data/learnings` | Directory for learnings storage |

\* One of `GITHUB_PRIVATE_KEY_PATH` or `GITHUB_PRIVATE_KEY` is required.

**Auto-ignored files:** lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), minified assets (`*.min.js`, `*.min.css`), sourcemaps (`*.map`), build output (`dist/**`, `build/**`, `.next/**`).

## Architecture

```
GitHub Webhook
      |
      v
  server.ts          ─── Express app, webhook routing, signature verification
      |
      v
  reviewer.ts        ─── Orchestrator: config, gates, knowledge, AI, posting
      |
      ├── repo-config.ts    ─── .diffsentry.yaml loading & defaults
      ├── guidelines.ts     ─── Auto-detect CLAUDE.md, AGENTS.md, etc.
      ├── issues.ts         ─── Parse & fetch linked GitHub issues
      ├── learnings.ts      ─── Per-repo learning storage
      ├── commands.ts       ─── @mention command parsing
      ├── walkthrough.ts    ─── Walkthrough comment formatting
      ├── pre-merge.ts      ─── Pre-merge validation checks
      ├── finishing-touches.ts ─── Docstrings, tests, simplify, autofix
      |
      ├── ai/prompt.ts      ─── Prompt engineering (profiles, paths, knowledge)
      ├── ai/parse.ts       ─── Response parsing & validation
      ├── ai/anthropic.ts   ─── Claude provider
      └── ai/openai.ts      ─── OpenAI provider
      |
      v
  github.ts          ─── GitHub API client (reviews, comments, statuses, labels)
```

## Webhook Events Handled

| Event | Action | Behavior |
|-------|--------|----------|
| `pull_request` | `opened` | Full review + walkthrough |
| `pull_request` | `synchronize` | Incremental review |
| `pull_request` | `ready_for_review` | Full review (draft became ready) |
| `pull_request` | `closed` | Abort in-flight reviews |
| `issue_comment` | `created` | Chat commands (`@bot ...`) |
| `pull_request_review_comment` | `created` | Chat commands on review threads |

## Comparison with CodeRabbit

| Feature | CodeRabbit | DiffSentry |
|---------|-----------|------------|
| Automatic PR reviews | Yes | Yes |
| Inline comments with fixes | Yes | Yes |
| Review profiles (chill/assertive) | Yes | Yes |
| Walkthrough comment | Yes | Yes |
| PR description summary | Yes | Yes |
| Sequence diagrams | Yes | Yes |
| Effort estimate | Yes | Yes |
| Suggested labels/reviewers | Yes | Yes |
| Auto-apply labels | Yes | Yes |
| Interactive chat commands | Yes | Yes |
| YAML per-repo config | Yes | Yes |
| Path filters & instructions | Yes | Yes |
| Auto-review controls | Yes | Yes |
| Incremental reviews | Yes | Yes |
| Linked issue context | Yes | Yes |
| Related PRs | Yes | Yes |
| Code guidelines detection | Yes | Yes |
| Learnings/memory | Yes | Yes |
| Pre-merge checks | Yes | Yes |
| Commit status checks | Yes | Yes |
| Generate docstrings | Yes | Yes |
| Generate unit tests | Yes | Yes |
| Code simplification | Yes | Yes |
| Autofix review comments | Yes | Yes |
| Abort on PR close | Yes | Yes |
| Auto-pause after N commits | Yes | Yes |
| Comment severity levels | Yes | Yes |
| Multi-provider AI | Anthropic/OpenAI | Anthropic/OpenAI |
| 50+ static analysis tools | Yes | No (AI-only) |
| AST-grep rules | Yes | No |
| Jira/Linear integration | Yes | No |
| GitLab/Azure/Bitbucket | Yes | GitHub only |
| Web dashboard | Yes | No |
| Merge conflict resolution | Yes | No |
| Custom recipes | Yes | No |
| Self-hosted | Enterprise only | Always |
| Data ownership | SaaS | Full control |
| Cost | $19+/user/mo | Your AI API costs |

## License

MIT
