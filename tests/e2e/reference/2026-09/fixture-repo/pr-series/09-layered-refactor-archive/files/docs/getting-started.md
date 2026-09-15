# Getting started

This service stores reports in memory and exposes them over HTTP, scoped to
the owner who created them. A background worker prunes old reports on a
timer, an archival job ships a per-owner manifest to cold storage ahead of
that sweep, and a small Python worker polls an external source and forwards
each item into the pipeline.

## Prerequisites

- Node.js 22 or later
- Python 3.12 or later, with `pytest` installed for the ingest suite

## Running the service

Install dependencies and start the server:

```bash
npm install
npm run dev
```

The server listens on port 3000 by default. Override it, along with the log
level, retention window, and archive destination, through environment
variables:

| Variable         | Default            | Meaning                                          |
| ---------------- | ------------------ | ------------------------------------------------- |
| `PORT`           | `3000`             | HTTP port the server listens on                    |
| `LOG_LEVEL`      | `info`             | Log verbosity                                      |
| `RETENTION_MS`   | 7 days             | How long a report is kept before pruning           |
| `ARCHIVE_BUCKET` | `reports-archive`  | Cold-storage bucket the archival job writes to     |
| `ARCHIVE_REGION` | `us-east-1`        | Region for the archive bucket                      |

## Using the API

Every request must identify its owner with an `x-owner-id` header. See
`openapi.yaml` for the full contract.

Create a report:

```bash
curl -X POST http://localhost:3000/reports \
  -H 'content-type: application/json' \
  -H 'x-owner-id: acme' \
  -d '{"title": "Q3 summary", "body": "Revenue up 12% quarter over quarter."}'
```

List an owner's reports:

```bash
curl http://localhost:3000/reports -H 'x-owner-id: acme'
```

## Running the tests

TypeScript suite:

```bash
npm test
```

Python suite:

```bash
cd ingest
pip install -r requirements.txt
python3 -m pytest -q
```

## Project layout

- `src/config.ts` — reads server configuration from the environment.
- `src/store.ts` — the in-memory, owner-scoped report store.
- `src/routes/` — one module per HTTP endpoint.
- `src/router.ts` — dispatches requests to `src/routes/`.
- `src/archive/` — the scheduled archival job.
- `src/worker.ts` — the pruning worker, run on a timer by `src/index.ts`.
- `src/index.ts` — wires the pieces together and starts the server.
- `ingest/worker.py` — a standalone polling ingester.
