# E2E + Deploy Loop

How DiffSentry development closes the loop — edit source, push, redeploy
the running bot, exercise it via real PRs on a sandbox repo, read the
captured transcripts. Built so an AI agent (or a human) can iterate on
the bot's behavior without ever taking a screenshot of a PR comment.

## Pieces

| Layer | Lives at | Purpose |
|---|---|---|
| **Sandbox repo** | A private GitHub repo you create with the DiffSentry App installed on it | Throw-away PRs that the harness opens, polls, and closes — never test on a working repo |
| **Redeploy script** | `scripts/local/redeploy.sh` (gitignored) | One command: SSH to the host, `git pull --ff-only`, `docker compose up --build -d` |
| **E2E harness** | `tests/e2e/` | TypeScript scenario runner that opens real PRs, polls for bot output, captures everything to a transcript |
| **Reference data** | `tests/e2e/reference/` | A live capture of CodeRabbit's comment shape on a real PR + a parity rubric mapping each surface to its DiffSentry source location |
| **PRD for the dashboard** | `docs/PRD-web-dashboard.md` | Scope for the next major surface (read-only web dashboard backed by the persistent storage layer) |

## One-time setup (operator)

1. **Deploy the bot.** Build the Docker image, run `docker compose up -d` on
   a host reachable from GitHub webhooks. Standard setup is documented in
   the top-level README.
2. **Create a GitHub App** with the permissions listed in the README and
   install it on **both** your production repos AND a dedicated sandbox
   repo. The sandbox repo can be private — the bot just needs install
   access. Bot login will be `<bot-name>[bot]` (default `diffsentry[bot]`).
3. **Create the redeploy shortcut.** This file is **gitignored on
   purpose** because it carries your SSH host. Create it locally:

   ```bash
   mkdir -p scripts/local
   cat > scripts/local/redeploy.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   SSH_TARGET="${DIFFSENTRY_SSH_TARGET:?set DIFFSENTRY_SSH_TARGET=user@host}"
   SSH_PORT="${DIFFSENTRY_SSH_PORT:-22}"
   REMOTE_PATH="${DIFFSENTRY_REMOTE_PATH:?set DIFFSENTRY_REMOTE_PATH=/path/to/DiffSentry}"
   ssh -p "${SSH_PORT}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${SSH_TARGET}" \
     "set -e; cd '${REMOTE_PATH}'; git pull --ff-only; docker compose up --build -d"
   echo "[redeploy] done"
   EOF
   chmod +x scripts/local/redeploy.sh
   ```

   Then either set the env vars in your shell, or hard-code your defaults
   inside the script (since it's gitignored). **Never** commit this file
   with real values.
4. **Set the harness sandbox target.** The harness reads the sandbox repo
   from the env var `SANDBOX_REPO` (default `mk7luke/diffsentry-sandbox`,
   which won't work for anyone but the original author). Override it:

   ```bash
   export SANDBOX_REPO=<your-org>/<your-sandbox-repo>
   export BOT_LOGIN=diffsentry[bot]   # optional, defaults to diffsentry[bot]
   ```

   Or put them in a local-only `.env.e2e` and source before running.
5. **Confirm SSH key auth works.** `ssh -p <port> <user>@<host> "echo ok"`
   should succeed without a password prompt before the redeploy script
   will work non-interactively.

## The loop

```
edit src/*.ts           # change behavior
git push origin main    # publish
scripts/local/redeploy.sh   # rebuild + restart bot on host (~10s)
npm run e2e -- <name>   # exercise on a real PR
                        # read tests/e2e/runs/<ts>_<name>/transcript.md
```

Total cycle: ~30s for `gh`-only scenarios, ~60–90s for ones that wait on
the AI to finish a review. A full `npm run e2e -- --all` is ~15 min for
the current scenario set.

## Harness usage

```bash
npm run e2e -- --list           # show every registered scenario
npm run e2e -- divide-by-zero   # one scenario
npm run e2e -- --all            # the full suite
```

Each run produces:

```
tests/e2e/runs/<iso-timestamp>_<scenario>/
  transcript.md      ← read this first; human-friendly capture
  walkthrough.md     ← the bot's walkthrough comment, raw
  run.json           ← structured dump (all reviews, comments, statuses)
```

The harness opens a PR, polls every 6s until its `waitFor` conditions
are met (or its timeout fires), captures every bot artifact, then
**closes the PR and deletes the branch** — the sandbox stays clean
even on failures.

### Adding a scenario

1. Drop a `.ts` file in `tests/e2e/scenarios/` exporting a `Scenario`.
2. Register it in `tests/e2e/scenarios/index.ts`.
3. `npm run e2e -- <name>`.

The `Scenario` shape lives in `tests/e2e/types.ts`. Two patterns are
worth knowing:

- **Chat-trigger scenarios** post a `@bot <command>` comment via
  `postPrActions: [{ type: "comment", body: "@diffsentry tldr" }]` and
  use `waitFor.replyContains: ["## TL;DR"]` to wait semantically for
  the reply, not by counting comments. Don't use
  `botIssueCommentsAtLeast` for new chat scenarios — adding any new
  always-on bot comment surface (sticky status was the most recent)
  silently breaks count-based waits.
- **Incremental-review scenarios** push a second commit via
  `postPrActions: [{ type: "push", files: [...] }]` and gate with
  `reviewsAtLeast: 2` so the harness waits for the post-push review.

## Persistent storage

The bot writes a `data/diffsentry.db` SQLite file (mounted as a Docker
volume so it survives redeploys) with one row per webhook event, review,
finding, and pattern hit. Schema in `src/storage/db.ts`, DAO in
`src/storage/dao.ts`. Inspect on the host:

```bash
ssh <user>@<host> 'docker exec <container-name> node -e "const db=require(\"better-sqlite3\")(\"/app/data/diffsentry.db\",{readonly:true}); for (const t of [\"repos\",\"prs\",\"reviews\",\"findings\",\"events\",\"pattern_hits\"]) console.log(t.padEnd(15), db.prepare(\`SELECT COUNT(*) AS c FROM \${t}\`).get().c);"'
```

Disable persistence locally with `DB_PATH=""` in the env.

## Dashboard

The read-only dashboard at `/dashboard` is off by default. To enable on the
live server:

```
ENABLE_DASHBOARD=1
DASHBOARD_URL=https://<your-host>/dashboard
GITHUB_OAUTH_CLIENT_ID=<from the App's General tab>
GITHUB_OAUTH_CLIENT_SECRET=<generated on the App's General tab>
DASHBOARD_ALLOWED_LOGINS=<your-github-login>       # or
DASHBOARD_ALLOWED_ORGS=<your-org-slug>
```

Add `https://<your-host>/dashboard/auth/callback` to the App's **Callback
URLs**. Then `scripts/local/redeploy.sh` and visit `/dashboard`.

Seed history so the overview isn't empty on first run:

```bash
ssh <user>@<host> 'docker exec <container-name> npm run backfill'
```

Smoke-test locally (no server / no auth, spins a temp SQLite):

```bash
npm run smoke:dashboard
```

Full design doc: [`docs/PRD-web-dashboard.md`](PRD-web-dashboard.md).

## Things to never commit

- `scripts/local/**` (whole dir is gitignored — keep deploy targets,
  one-off scripts, anything host-specific here)
- `.env` (gitignored — secrets live here)
- `private-key.pem` / `*.pem` (gitignored — GitHub App private keys)
- `data/` (gitignored — the SQLite file)
- `tests/e2e/runs/` (gitignored — captured transcripts; some include
  PR titles / bodies you may not want to surface)
- `tests/e2e/.work/` (gitignored — temporary git clones the harness uses)

If you ever add a script with hard-coded SSH info / API keys / repo
names that should stay private, either put it under `scripts/local/`
or add a new entry to `.gitignore` first.

## Common pitfalls

- **Suite times out on a chat scenario.** Usually means
  `waitFor.replyContains` doesn't match the actual reply. Open the
  failing transcript, look at what the bot actually said, adjust the
  needle.
- **PR opens but bot never responds.** Check that the App is installed
  on the sandbox repo (App settings → Install App → repos list) and
  that the redeploy actually completed (look for `[redeploy] done`).
- **`@bot reply` lands as a top-level comment instead of in the
  thread.** Was a real bug; fixed. If it recurs, the
  `pull_request_review_comment` webhook handler in `src/server.ts`
  passes `commentKind: "review_thread"` to `handleComment`; if that
  path is missing, the bot falls back to issues.createComment.
- **Markdown link inside `<details>` renders as raw `[text](url)`.**
  GitHub's GFM parser only treats content inside `<details>` as
  markdown when there's a blank line after `<summary>`. The
  `renderReviewInfo` helper in `src/review-body.ts` preserves these
  blanks; don't strip them when adding new sections.

## See also

- `tests/e2e/README.md` — harness reference (CLI, scenario shape,
  output format).
- `tests/e2e/reference/CODERABBIT-FORMAT.md` — the parity rubric;
  open this when adding a new "match CodeRabbit" surface.
- `docs/PRD-web-dashboard.md` — full scope for the next major surface
  (read-only dashboard backed by the persistent storage layer above).
- `README.md` § Architecture — module-level map of what calls what.
