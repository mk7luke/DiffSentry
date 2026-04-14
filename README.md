# DiffSentry

Self-hosted AI-powered GitHub pull request review bot. Automatically reviews PRs when they're opened or updated, providing inline comments with actionable feedback on bugs, security, performance, and maintainability.

## Features

- Automatic PR reviews on open and push events
- Inline comments on specific lines with suggested fixes
- Supports OpenAI (GPT/o3) and Anthropic (Claude) models
- Dismisses previous bot reviews to avoid clutter
- Configurable file ignore patterns
- Docker support

## Setup

### 1. Create a GitHub App

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. Set the **Homepage URL** to your domain
3. Set the **Webhook URL** to `https://yourdomain.com/webhook`
4. Set a **Webhook secret** (e.g. `openssl rand -hex 20`)
5. Under **Permissions & events > Repository permissions**, set **Pull requests** to **Read & write**
6. Under **Subscribe to events**, check **Pull request**
7. Click **Create GitHub App**
8. On the app's General page, note the **App ID**
9. Under **Private keys**, click **Generate a private key** and save the `.pem` file

### 2. Install the App

Go to your GitHub App's settings, click **Install App**, and select the repositories you want reviewed.

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```
GITHUB_APP_ID=your-app-id
GITHUB_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret

AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=o3
```

See `.env.example` for all available options including Anthropic configuration.

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

The server starts on port 3000 by default. The webhook endpoint is `POST /webhook` and a health check is available at `GET /health`.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | Yes* | `./private-key.pem` | Path to private key file |
| `GITHUB_PRIVATE_KEY` | Yes* | | Private key as string (alternative to path) |
| `GITHUB_WEBHOOK_SECRET` | Yes | | Webhook signature secret |
| `AI_PROVIDER` | No | `anthropic` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | If anthropic | | Anthropic API key |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Anthropic model |
| `OPENAI_API_KEY` | If openai | | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-4o` | OpenAI model |
| `PORT` | No | `3000` | Server port |
| `MAX_FILES_PER_REVIEW` | No | `50` | Max files per review |
| `IGNORED_PATTERNS` | No | | Comma-separated glob patterns to skip |

\* One of `GITHUB_PRIVATE_KEY_PATH` or `GITHUB_PRIVATE_KEY` is required.

Lock files, minified assets, sourcemaps, and common build output directories are ignored automatically.

## License

MIT
