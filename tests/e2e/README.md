# DiffSentry e2e harness

Drives the running DiffSentry instance against a real GitHub sandbox repo so behavior
can be observed end-to-end without manual screenshots. Each scenario opens a real PR,
waits for the bot to act, captures every comment / review / status, and writes a
human-readable transcript.

## Prerequisites

- DiffSentry is deployed and reachable from GitHub webhooks.
- The DiffSentry GitHub App is installed on the sandbox repo (default
  `mk7luke/diffsentry-sandbox`).
- Local `gh` CLI authenticated with `repo` scope.
- `git` available on PATH.

## Run

```bash
npm run e2e -- --list                # show available scenarios
npm run e2e -- divide-by-zero        # run one scenario
npm run e2e -- --all                 # run them all
```

## Output

Each run writes to `tests/e2e/runs/<timestamp>_<scenario>/`:

| File | Contents |
|---|---|
| `transcript.md` | Human-readable summary — read this first. |
| `walkthrough.md` | Bot-posted walkthrough body, if any. |
| `run.json` | Full structured capture (reviews, inline comments, statuses, expectations). |

The harness closes its PR and deletes its branch on completion (success or failure),
so the sandbox stays clean.

## Environment overrides

| Variable | Default |
|---|---|
| `SANDBOX_REPO` | `mk7luke/diffsentry-sandbox` |
| `BOT_LOGIN` | `diffsentry[bot]` |

## Adding a scenario

1. Create `tests/e2e/scenarios/my-thing.ts` exporting a `Scenario`.
2. Register it in `scenarios/index.ts`.
3. Run with `npm run e2e -- my-thing`.

A scenario declares the files to commit, the PR title/body, optional follow-up
chat-command actions, what to wait for, and (optionally) expectations that flip
the run to PASS/FAIL. Expectations are *soft* — even if they fail, the captured
transcript still tells you exactly what happened.
