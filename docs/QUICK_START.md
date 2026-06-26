# Quick Start (≈10 minutes)

Get DiffSentry reviewing a real pull request in about ten minutes. This is the
fast path — for the full reference see the [README](../README.md) and
[docs/DEPLOYMENT.md](./DEPLOYMENT.md).

You need: Docker (with `docker compose`), an AI provider API key
(Anthropic **or** OpenAI **or** a local OpenAI-compatible server), and a GitHub
account with admin access to one repo.

---

## 1. Create a GitHub App (~3 min)

**GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.**

- **Webhook URL** — where GitHub will POST events: `https://<your-host>/webhook`.
  Testing locally? Run a tunnel (`cloudflared tunnel --url http://localhost:3005`
  or `ngrok http 3005`) and use the public URL it prints, with `/webhook` appended.
- **Webhook secret** — generate one and keep it: `openssl rand -hex 20`.
- **Repository permissions:** Pull requests **Read & write**, Contents
  **Read & write**, Issues **Read & write**, Commit statuses **Read & write**.
- **Subscribe to events:** Pull request, Issues, Issue comment, Pull request
  review comment.

Click **Create**. Then on the App page:

1. Note the **App ID** (numeric, top of the page).
2. **Generate a private key** → downloads a `.pem`. Save it as `private-key.pem`
   in the project root (next to `docker-compose.yml`).

## 2. Configure `.env` (~2 min)

The fastest way:

```bash
npm install        # once, to get the `setup` script's runner
npm run setup      # interactive: asks for the App ID, secret, AI provider, etc.
```

Prefer to do it by hand? Copy the example and fill in **only** the required vars:

```bash
cp .env.example .env
```

Minimal required set:

| Variable | What it is |
| --- | --- |
| `GITHUB_APP_ID` | The numeric App ID from step 1. |
| `GITHUB_PRIVATE_KEY_PATH` | Path to the `.pem`. Default `./private-key.pem` works with the compose mount below. |
| `GITHUB_WEBHOOK_SECRET` | The `openssl rand` secret from step 1. |
| `AI_PROVIDER` | `anthropic`, `openai`, or `openai-compatible`. |
| **one** credential, matching the provider: | |
| &nbsp;&nbsp;• `ANTHROPIC_API_KEY` | if `AI_PROVIDER=anthropic` |
| &nbsp;&nbsp;• `OPENAI_API_KEY` | if `AI_PROVIDER=openai` |
| &nbsp;&nbsp;• `LOCAL_AI_BASE_URL` **and** `LOCAL_AI_MODEL` | if `AI_PROVIDER=openai-compatible` |

Everything else in `.env.example` has a sane default — leave it commented out for
now. (Want the dashboard? Add `ENABLE_DASHBOARD=1`; see DEPLOYMENT.md for auth.)

## 3. Start it (~1 min)

```bash
docker compose up -d
```

This builds the image and starts DiffSentry on port `3005`. Compose mounts
`./private-key.pem` into the container (read-only) and persists data in the
`diffsentry-data` volume — see [docker-compose.yml](../docker-compose.yml).

Check it's healthy:

```bash
curl localhost:3005/health      # → {"status":"ok",...}
docker compose logs -f          # watch for "DiffSentry is running"
```

If your webhook URL is a tunnel, make sure the tunnel is pointing at
`localhost:3005`.

## 4. Install the App on one repo (~1 min)

On your GitHub App page → **Install App** → choose your account/org → select
**Only select repositories** → pick one repo → **Install**.

## 5. Open a test PR (~2 min)

In that repo:

```bash
git checkout -b diffsentry-test
echo "function add(a, b) { return a + b }" >> example.js
git add example.js && git commit -m "test: trigger a DiffSentry review"
git push -u origin diffsentry-test
```

Open the PR on GitHub. Within a few seconds DiffSentry posts a review (and a
walkthrough). Watch `docker compose logs -f` to see the webhook arrive and the
review run.

---

## Troubleshooting

- **No review appears.** Tail the logs (`docker compose logs -f`). No webhook
  line at all → GitHub can't reach your Webhook URL (check the tunnel and that
  the URL ends in `/webhook`). The App's **Advanced → Recent Deliveries** page
  shows the response code GitHub got.
- **`GITHUB_WEBHOOK_SECRET` / signature errors.** The secret in `.env` must match
  the one set on the App exactly.
- **AI provider errors at boot.** A typo in `AI_PROVIDER` is rejected at startup
  with the list of valid values — it must be one of `anthropic`, `openai`,
  `openai-compatible`. `npm run setup` validates this for you.
- **Private key not found.** `GITHUB_PRIVATE_KEY_PATH` must point at the file
  compose mounts — keep the `.pem` at the project root as `private-key.pem`.

Next steps: tailor reviews per-repo with `.diffsentry.yaml` (see the README's
"Per-repo configuration"), and read [docs/DEPLOYMENT.md](./DEPLOYMENT.md) to run
it durably (systemd, a managed host, or Kubernetes) with the dashboard and
OAuth enabled.
