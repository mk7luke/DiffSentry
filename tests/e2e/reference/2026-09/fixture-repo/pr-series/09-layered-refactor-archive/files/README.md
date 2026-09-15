# reports-fixture

A small, self-contained "reports" service: an HTTP API backed by an in-memory
store, a background pruning worker, and a Python ingest worker alongside it.

This is a **fixture**, not part of DiffSentry itself. It exists so a
generated series of pull requests can be opened against a copy of it,
each designed to provoke one specific automated-review behaviour, for
comparing DiffSentry against another review bot. See
`../../../../../docs/superpowers/specs/2026-09-15-coderabbit-parity-capture-design.md`
for the full design.

## Isolation

- This directory is never installed from the parent repo — its
  `package.json` is not referenced by the root `package.json`, and the root
  `tsconfig.json`'s `include` does not reach here.
- Its own dependencies live only in this directory's `node_modules`, which is
  git-ignored and does not exist in a checkout of the parent repo.

## Running it standalone

```bash
cd tests/e2e/reference/2026-09/fixture-repo
npm install
npm test        # runs the TypeScript suite (vitest)
npm run build    # type-checks and compiles to dist/
```

```bash
cd tests/e2e/reference/2026-09/fixture-repo/ingest
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest -q
```

**Operator prerequisite:** the Python suite needs `python3` and `pytest`
available (`pip install -r ingest/requirements.txt`). If pytest is not on the
machine running this fixture, install it before relying on the Python test
step — it is not otherwise skipped or worked around.

## Layout

- `src/routes/` — one module per HTTP endpoint, dispatched by `src/router.ts`
  through a small route table.
- `src/archive/` — the scheduled job that ships a per-owner manifest to cold
  storage ahead of the retention sweep.
- `src/store.ts` — the in-memory, owner-scoped report store.
- `src/retention.ts` — the pure predicate `prune` filters rows by.
- `src/config.ts` — reads server configuration from the environment,
  including the archive bucket and region.
- `src/worker.ts` — the pruning worker, run on a timer by `src/index.ts`.
- `src/index.ts` — wires the pieces together and starts the server.
- `test/` — its vitest suite.
- `ingest/` — a small Python polling worker with its own pytest suite.
- `.github/workflows/ci.yml` — runs both suites.
- `openapi.yaml` — the `/reports` API contract.
- `docs/getting-started.md` — a short operator-facing guide.
- `pr-series/` — the PR definitions applied on top of this seed (added by a
  later step; not part of the seed itself).
