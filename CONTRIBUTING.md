# Contributing to DiffSentry

Thanks for your interest in improving DiffSentry — a self-hosted, AI-powered
GitHub pull-request review bot. This guide covers local setup, the test suite,
the dev loop, and our branch/PR conventions.

## Prerequisites

- **Node.js 20+** (the project targets ES2022; the Docker image is built on a
  current LTS Node).
- **npm** (the repo ships a `package-lock.json`; use `npm ci` for reproducible
  installs).
- A C toolchain for `better-sqlite3`'s native build (usually already present on
  macOS/Linux dev machines).

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Build the server (TypeScript → dist/) and the SPA (Vite → web/dist/)
npm run build
```

`npm run build` runs two steps:

- `npm run build:server` — `tsc`, compiling `src/**` to `dist/`.
- `npm run build:web` — `npm --prefix web ci && npm --prefix web run build`,
  building the React/Vite command-center SPA into `web/dist`.

If you only touched the backend, `npm run build:server` is enough; if you only
touched the SPA, `npm run build:web` is enough.

To run the bot you'll need a GitHub App and the environment configured — copy
`.env.example` to `.env` and fill it in (the full variable table is in the
[README](README.md#environment-variables)).

## Dev loop

The backend serves the API + webhook on port **3005**; the SPA runs on the Vite
dev server with a proxy so `/api` calls reach the backend:

```bash
# Terminal 1 — backend (API + webhook) with live reload via tsx watch
ENABLE_DASHBOARD=1 npm run dev          # http://localhost:3005

# Terminal 2 — SPA dev server (proxies /api → :3005)
npm run dev:web                         # http://localhost:5174
```

`npm run dev` runs `tsx watch src/index.ts`, so the server restarts on save.

The full edit → push → redeploy → real-PR loop (sandbox repo, redeploy script,
persistent SQLite inspection) is documented in
[`docs/E2E-DEPLOY-LOOP.md`](docs/E2E-DEPLOY-LOOP.md). Read that doc when
iterating on bot behavior against live PRs.

## Tests

DiffSentry's test suite is a set of **smoke scripts** under `scripts/`, each run
with `tsx` against a temporary SQLite database. They stand up the relevant
surface end-to-end and assert on its behavior. Run them individually:

```bash
npm run smoke:dashboard        # dashboard routes end-to-end
npm run smoke:api              # /api/v1 read endpoints
npm run smoke:rbac             # role gating (viewer/author/admin)
npm run smoke:actions          # command-action endpoints
npm run smoke:notifications    # notification channels + rules
npm run smoke:branding         # instance name / accent branding
npm run smoke:settings         # operator settings overrides
npm run smoke:tokens           # platform API tokens
npm run smoke:config           # repo .diffsentry.yaml editor
npm run smoke:learnings        # learnings CRUD
npm run smoke:queue            # review-pipeline queue board
npm run smoke:migrate          # migration runner
npm run smoke:dao              # data-access layer
npm run smoke:cost             # AI cost tracking
npm run smoke:webhooks         # webhook capture + replay
npm run smoke:signature        # webhook signature verification
```

Before opening a PR, at minimum:

1. `npm run build` must pass (server **and** SPA compile).
2. Run the `smoke:*` script(s) covering the area you changed.

There is also a real-PR end-to-end harness in `tests/e2e/` driven by
`npm run e2e` (opens PRs on a sandbox repo and captures transcripts). It needs a
configured sandbox + running bot, so it's not part of the quick local loop — see
the README's "End-to-end test harness" section.

## Where the architecture lives

- **High-level architecture** — the request flow (webhook → `server.ts` →
  `reviewer.ts` orchestrator → the per-concern modules → `github.ts`) and a
  module-by-module map are in the [README "Architecture" section](README.md#architecture).
- **The reviewer pipeline** lives in `src/` — `reviewer.ts` is the orchestrator;
  scanners, insights, walkthrough/review-body renderers, and the AI providers
  (`src/ai/`) sit alongside it.
- **Web command center** — the API-first React SPA is under `web/`, fed by the
  `/api/v1` JSON API.
- **Storage & migrations** — SQLite via `better-sqlite3`; the ordered migration
  runner and schema are documented in [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md).
- **Per-repo config** — `.diffsentry.example.yaml` documents every
  `.diffsentry.yaml` option inline.

## Branch & PR conventions

- **Branch from `main`.** Use a short, prefixed branch name describing the work,
  e.g. `feat/notification-channels`, `fix/webhook-signature`,
  `chore/credibility-files`, `docs/...`.
- **Keep PRs focused.** One logical change per PR; DiffSentry's own walkthrough
  works best on cohesive diffs.
- **Write clear commit subjects.** Imperative mood, no trailing period
  (`Add weekly digest`, not `Added weekly digest.`). DiffSentry's commit-message
  and PR-title coaches will nudge you toward this on your own PRs.
- **Update docs alongside code.** If you add an env var, endpoint, or surface,
  update the README table/section in the same PR, and add a `CHANGELOG.md`
  entry under `## [Unreleased]`.
- **Verify before requesting review.** `npm run build` passes and the relevant
  `smoke:*` script is green.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
