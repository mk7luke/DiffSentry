# Getting started

This service stores reports in memory and exposes them over HTTP, scoped to
the owner who created them. A background worker prunes old reports on a
timer, and a small Python worker polls an external source and forwards each
item into the pipeline.

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
level and retention window, through environment variables:

| Variable        | Default        | Meaning                                   |
| --------------- | -------------- | ------------------------------------------ |
| `PORT`          | `3000`         | HTTP port the server listens on            |
| `LOG_LEVEL`     | `info`         | Log verbosity                              |
| `RETENTION_MS`  | 7 days         | How long a report is kept before pruning   |

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

## Troubleshooting

If a request is rejected with a 400 status, it is usually because the
`x-owner-id` header was not included by the client. A 400 is also returned
when the request body cannot be parsed as JSON, or when a title or body was
left empty by the caller. In each of these cases, the record is not
created, and no report id is returned in the response.

Tenants are isolated from one another: a record inserted for one tenant
cannot be seen by another owner's list request, even when the report id is
known ahead of time. This separation is enforced by the store, so it cannot
be bypassed at the router layer. If a report that was just created cannot
be found afterward, the owner header used for the two requests should be
compared first, since a typo there is the most common cause.

## Deploying

The service is started by running `npm run build`, followed by `node
dist/index.js`. A reverse proxy should be placed in front of it by
whoever operates the deployment, since TLS termination is not handled by
the process itself.

Logs are written to stdout in a single line per event, and should be
collected by whatever log aggregation is already used in the deployment
environment. No log file is written by the process, and none should be
assumed to exist by anything shelling out to it.

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
- `src/router.ts` — the HTTP handler for `/reports`.
- `src/worker.ts` — the pruning worker, run on a timer by `src/index.ts`.
- `src/index.ts` — wires the pieces together and starts the server.
- `ingest/worker.py` — a standalone polling ingester.
