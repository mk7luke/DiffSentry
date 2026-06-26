# Deployment

DiffSentry is a single Node service: one container (or process) that serves the
webhook receiver, the JSON API, and — when enabled — the dashboard SPA, all on
one port (`3005` by default). State is a single SQLite file under `./data`
(`/app/data` in Docker). There is nothing else to run; scale considerations are
mostly "give the one process a stable home and a persistent disk".

New here? Start with [QUICK_START.md](./QUICK_START.md) to get a review working
locally, then come back to make it durable.

Whatever the target, you need the same inputs:

- `GITHUB_APP_ID`, the App's private key, and `GITHUB_WEBHOOK_SECRET`
- an AI provider + credential (`AI_PROVIDER` + `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `LOCAL_AI_BASE_URL`+`LOCAL_AI_MODEL`)
- a **persistent** location for `./data` so the dashboard's history and settings
  survive restarts

> **Private key: file vs. inline.** Locally and with Docker Compose you mount the
> `.pem` and point `GITHUB_PRIVATE_KEY_PATH` at it. On managed hosts (Render,
> Railway, Fly, …) you usually can't mount a file — paste the PEM contents into
> `GITHUB_PRIVATE_KEY` instead. `src/config.ts` accepts either.

---

## Docker (recommended)

The repo ships a multi-stage [`Dockerfile`](../Dockerfile) (builds the SPA, then
the server, then a slim runtime image) and a [`docker-compose.yml`](../docker-compose.yml).

```bash
cp .env.example .env        # or: npm run setup
# put the App's private key at ./private-key.pem (compose mounts it read-only)
docker compose up -d --build
```

Compose already does the durable bits:

- mounts `./private-key.pem` → `/app/private-key.pem:ro`
- persists the named volume `diffsentry-data` → `/app/data` (the SQLite DB)
- `restart: unless-stopped`
- publishes `${PORT:-3005}:3005`

Health: `curl localhost:3005/health`. Logs: `docker compose logs -f`. Upgrade:
`git pull && docker compose up -d --build`.

To run the image without Compose, supply the same mounts/volume yourself:

```bash
docker build -t diffsentry .
docker run -d --name diffsentry --restart unless-stopped \
  -p 3005:3005 --env-file .env \
  -v "$PWD/private-key.pem:/app/private-key.pem:ro" \
  -v diffsentry-data:/app/data \
  diffsentry
```

## Managed hosts (Render / Railway)

A [`render.yaml`](../render.yaml) Blueprint is included. In Render: **New →
Blueprint**, point at this repo, and fill in the secret env vars it prompts for.
It builds the existing Dockerfile, attaches a 1 GB persistent disk at
`/app/data`, and uses `/health` as the health check. Set `GITHUB_PRIVATE_KEY`
(inline PEM), not `GITHUB_PRIVATE_KEY_PATH`.

Railway (or any Docker-based PaaS) works the same way: deploy from the
Dockerfile, attach a volume mounted at `/app/data`, and set the env vars above.
The only platform-specific gotcha is the private key — use the inline
`GITHUB_PRIVATE_KEY` form.

After deploy, set the GitHub App's **Webhook URL** to
`https://<your-host>/webhook` and install the App on your repos.

## systemd (bare VM)

For a plain VM without Docker. Build once, then run the compiled server under
systemd.

```bash
# as a deploy user, in /opt/diffsentry (a clone of this repo)
npm ci
npm run build            # builds dist/ (server) and web/dist (SPA)
```

`/etc/systemd/system/diffsentry.service`:

```ini
[Unit]
Description=DiffSentry PR review bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=diffsentry
WorkingDirectory=/opt/diffsentry
# EnvironmentFile holds the same vars as .env (KEY=value, no `export`).
EnvironmentFile=/opt/diffsentry/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
# data/ (the SQLite DB) lives under WorkingDirectory and persists across restarts.

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now diffsentry
sudo systemctl status diffsentry
journalctl -u diffsentry -f
```

Put a TLS-terminating reverse proxy (nginx/Caddy) in front so GitHub can reach
`https://<host>/webhook`. Proxy to `127.0.0.1:3005`. Upgrades:
`git pull && npm ci && npm run build && sudo systemctl restart diffsentry`.

## Kubernetes (note)

No manifests are shipped, but DiffSentry maps cleanly onto a single-replica
`Deployment` + `Service` + `Ingress` using the same Docker image:

- **Run one replica.** State is a local SQLite file, so multiple replicas would
  each get their own DB and webhooks would be split across them. Use
  `replicas: 1` and a `Recreate` (not `RollingUpdate`) strategy.
- **Persist `/app/data`** with a `PersistentVolumeClaim` (`ReadWriteOnce` is
  fine for a single replica). Without it, the dashboard's history and settings
  reset on every pod restart.
- **Secrets:** put `GITHUB_PRIVATE_KEY` (inline PEM), `GITHUB_WEBHOOK_SECRET`,
  and the AI key in a `Secret`; the rest can be a `ConfigMap`. Mount them as env
  vars.
- **Probes:** point both `readinessProbe` and `livenessProbe` at
  `GET /health` on port `3005`.
- **Ingress:** terminate TLS at the ingress and route `/webhook` (and `/`, `/api`
  if you expose the dashboard) to the Service on port `3005`.

If you later need true horizontal scaling, that's a database swap (SQLite → a
networked DB), not a deployment-topology change — out of scope here.
