# Backup AI Provider / Failover — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorm), pending implementation
**Author:** Claude + Luke

## Problem

On PR #77, DiffSentry reviews intermittently failed with
`AiTimeoutError: AI request timed out after 60000ms (openai-compatible review)`.
On one push all retries hit the 60s timeout and the review was **dead-lettered**
(no review posted). Model: `grok-4.5` via an OpenAI-compatible endpoint.

Diagnosis established the dominant failure mode was **slow-hang / latency
variance on the large `review` call**, not a fast error or a confirmed outage:
the smaller `walkthrough` call (same endpoint/auth) succeeded in ~3s on every
failed attempt; the same `review` call finished in ~9s on other runs.

Two levers came out of that:
1. **Operational (out of scope here):** raise `AI_REQUEST_TIMEOUT_MS` / scope
   retries. Immediate mitigation, may already be applied on the deployment.
2. **This feature:** a real resilience feature — a secondary provider to fall
   back to so a degraded primary still yields a posted review.

This feature is **complementary** to lever 1, not a replacement.

## Ground truth (verified against the code)

- `AIProvider` (`src/types.ts:425`) has **five** methods: `review`,
  `generateWalkthrough`, `chat`, `chatIssue`, `complete`. A wrapper must
  implement all five.
- Three implementations conform: `AnthropicProvider` (`src/ai/anthropic.ts`),
  `OpenAIProvider` (`src/ai/openai.ts`), `OpenAICompatibleProvider`
  (`src/ai/openai-compatible.ts`).
  - `AnthropicProvider(apiKey, model, baseURL?, timeoutMs?)` — provider label
    hardcoded `"anthropic"`.
  - `OpenAIProvider(apiKey, model, baseURL?, timeoutMs?)` — label hardcoded
    `"openai"`.
  - `OpenAICompatibleProvider({ baseURL, model, apiKey?, jsonMode?,
    providerLabel?, timeoutMs? })` — accepts a `providerLabel`.
- The provider is constructed **once** in the `Reviewer` constructor
  (`src/reviewer.ts:211–223`) from flat `config` fields.
- Every model call is bounded by `withAiTimeout` (`src/ai/timeout.ts`) with a
  single per-provider `timeoutMs` = `config.aiRequestTimeoutMs`
  (`AI_REQUEST_TIMEOUT_MS`, default `DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000`).
  On timeout it rejects with typed `AiTimeoutError` (`isAiTimeoutError` helper)
  **before** cost is recorded, so a timed-out call writes no cost event.
- **Retry / dead-letter is NOT in `reviewer.ts`.** It lives in
  `src/realtime/jobs.ts::runReviewJob`: bounded retry (default 3 attempts,
  `REVIEW_RETRY_MAX_ATTEMPTS`) with exponential backoff, then dead-letter, only
  on `isTransientError`. It re-runs the **entire** `handlePullRequest`
  (walkthrough + review + verify + posting). The reviewer's own catch
  (`reviewer.ts:1558`) posts a failure status comment and **rethrows**.
- `isTransientError` (`jobs.ts:110`) classifies transient = transient network
  `code`s, HTTP status `>= 500` or `429`, `name` `AbortError`/`TimeoutError`,
  or a message matching hint substrings. `AiTimeoutError` is matched via the
  `"timed out"` message hint (its `.name` is `"AiTimeoutError"`).
- Cost attribution (`recordAiUsage`, `src/ai/cost.ts`) keys on **provider +
  model**. A backup of a different provider type, or the same type with a
  different model, is therefore already distinct in cost accounting.

## Design decisions (agreed in brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Trigger policy | Fast-fail on transient errors **+ short primary deadline** so slow-hang switches quickly. Never fail over on 4xx (auth/bad-request). |
| 2 | Failover scope | All five `AIProvider` methods, per-call, **sequential** (primary then backup). |
| 3 | Backup role | Peer-quality strong model. Output parity is realistic. |
| 4 | Output parity | Rely on existing `parseReviewResponse` + `verify.ts`. Backup failure falls through to today's failure/retry/dead-letter path (no regression). |
| 5 | Config surface | Env only (secrets), off by default: `BACKUP_AI_PROVIDER` selects type and **reuses** that provider's existing env, with optional `BACKUP_*` overrides. |
| 6 | Idempotency | Free — sequential per-call failover means the primary is aborted before the backup runs; no double-post window. No machinery. |
| 7 | Observability | Structured logs on failover + breaker transitions. Per-provider cost already attributed. Plus a subtle review-body "reviewed by backup" note. |
| 8 | Cost/abuse guardrail | In-memory circuit breaker on the wrapper: after N consecutive primary failures, skip primary for a cooldown. |

## Architecture

### `FailoverProvider implements AIProvider` — `src/ai/failover.ts`

Wraps a `primary` and `backup` `AIProvider`. Each of the five methods follows
the same shape:

```
async <method>(...args) {
  return this.run("<operation>", () => primary.<method>(...args),
                                 () => backup.<method>(...args));
}
```

`run(operation, primaryCall, backupCall)`:
1. If the circuit breaker is **open** (and cooldown not elapsed), skip the
   primary and call the backup directly (record `servedBy: "backup"`, reason
   `"circuit-open"`).
2. Otherwise call the primary.
   - On success: record a primary success (resets the breaker's consecutive-
     failure count / closes a half-open breaker). Return the result.
   - On error:
     - If **not** `shouldFailover(err)` (e.g. a 401/403, a 400, or any non-
       transient error): record a primary failure for breaker accounting **only
       if it is a connection/5xx-class failure** (auth/4xx must not trip the
       breaker — see below), then **rethrow** (no backup attempt).
     - If `shouldFailover(err)`: record a primary failure, log the failover with
       structured fields, then call the backup.
       - Backup success: return the backup result (annotated `servedBy:
         "backup"` where the result type carries it).
       - Backup failure: rethrow the **backup** error (the more recent /
         actionable one) so the job runner's retry/dead-letter path takes over
         exactly as today.

The wrapper adds **no** timeout of its own; it relies on each inner provider's
own `withAiTimeout`. The primary instance is constructed with the short
`primaryAiTimeoutMs`; the backup with the normal `aiRequestTimeoutMs`.

### Trigger predicate — shared, extracted

`shouldFailover(err)` must use the **same** rules as `jobs.ts::isTransientError`
to avoid drift. Extract `isTransientError` (and its `TRANSIENT_CODES`,
`TRANSIENT_MESSAGE_HINTS`, `statusOf`) into a new neutral module
`src/ai/transient.ts`. `jobs.ts` imports it from there (no behavior change);
`failover.ts` reuses it as the failover predicate.

- Fails over on: `AiTimeoutError`, transient network codes, HTTP `>= 500`, `429`.
- Does **not** fail over on: 401/403 (auth) and other 4xx — surfaced as-is so a
  bad primary key isn't silently masked by backup traffic.

**Breaker vs. failover distinction:** the breaker counts *primary reachability*
failures. A 4xx that doesn't fail over also should **not** trip the breaker
(it's deterministic, not a reachability problem). So the breaker increments only
when `shouldFailover(err)` is true; a non-failover error rethrows without
touching breaker state.

### Circuit breaker

In-memory state on the `FailoverProvider` instance (the `Reviewer` is
effectively a singleton, so state persists across reviews within a process):

- `consecutiveFailures: number`
- `openedAt: number | null` (epoch ms; `Date.now()`)

Behavior:
- Increment `consecutiveFailures` on each failover-eligible primary failure.
- When `consecutiveFailures >= threshold` (default 3), set `openedAt = now`
  → breaker **open**.
- While open and `now - openedAt < cooldownMs` (default 60_000): skip primary,
  go straight to backup.
- After cooldown: **half-open** — allow one primary probe. Success closes the
  breaker (`consecutiveFailures = 0`, `openedAt = null`); failure re-opens
  (`openedAt = now`).
- Any primary success closes the breaker.

Log `warn` on open, `info` on close, with counts.

### Provider construction — `buildProvider(spec)` helper

Extract the anthropic/openai/openai-compatible switch out of the `Reviewer`
constructor into a reusable factory (`src/ai/provider-factory.ts`, or a local
private function in `reviewer.ts`). Signature:

```ts
interface ProviderSpec {
  provider: "anthropic" | "openai" | "openai-compatible";
  anthropicApiKey?: string; anthropicModel: string; anthropicBaseUrl?: string;
  openaiApiKey?: string; openaiModel: string; openaiBaseUrl?: string;
  localAiBaseUrl?: string; localAiApiKey?: string; localAiModel: string;
  localAiJsonMode: boolean;
  timeoutMs: number;
  label?: string; // openai-compatible providerLabel override
}
function buildProvider(spec: ProviderSpec): AIProvider;
```

`Reviewer` constructor:
1. Build the **primary** provider from the existing flat config fields, with
   `timeoutMs = config.backupAiProvider ? config.primaryAiTimeoutMs : config.aiRequestTimeoutMs`.
   (When no backup is configured, the primary keeps the full 60s — the short
   deadline only makes sense when there's somewhere to fail over to.)
2. If `config.backupAiProvider` is set, build the **backup** provider from the
   resolved backup fields with `timeoutMs = config.aiRequestTimeoutMs`, then set
   `this.ai = new FailoverProvider(primary, backup, { threshold, cooldownMs })`.
3. Else `this.ai = primary` (unchanged behavior).

### Review-body transparency note (#7)

Add an optional `servedBy?: "primary" | "backup"` field to `ReviewResult`
(`src/types.ts`). The `FailoverProvider.review` sets it to `"backup"` when the
backup served the review (leaves it unset/`"primary"` otherwise). `reviewer.ts`,
when rendering the review body, appends a small footnote when
`reviewResult.servedBy === "backup"`, e.g.:

> <sub>ℹ️ Primary review model was unavailable; this review was generated by the
> configured backup provider.</sub>

Keep it subtle and additive — it must not alter approval/verification logic.
Only the `review` result carries the note (the substantive posted artifact); the
walkthrough's served-by is captured in logs only.

## Config surface (env, off by default)

New env vars (all optional; absence of `BACKUP_AI_PROVIDER` = feature off):

| Var | Meaning | Default |
|-----|---------|---------|
| `BACKUP_AI_PROVIDER` | `anthropic` \| `openai` \| `openai-compatible`. Unset ⇒ failover disabled. | (unset) |
| `PRIMARY_AI_TIMEOUT_MS` | Short primary deadline used only when a backup is configured. | `20000`, clamped to `≤ AI_REQUEST_TIMEOUT_MS` |
| `BACKUP_ANTHROPIC_API_KEY` / `BACKUP_ANTHROPIC_MODEL` / `BACKUP_ANTHROPIC_BASE_URL` | Overrides; reuse `ANTHROPIC_*` when unset. | reuse primary `ANTHROPIC_*` |
| `BACKUP_OPENAI_API_KEY` / `BACKUP_OPENAI_MODEL` / `BACKUP_OPENAI_BASE_URL` | Overrides; reuse `OPENAI_*` when unset. | reuse primary `OPENAI_*` |
| `BACKUP_LOCAL_AI_BASE_URL` / `BACKUP_LOCAL_AI_API_KEY` / `BACKUP_LOCAL_AI_MODEL` / `BACKUP_LOCAL_AI_JSON_MODE` | Overrides; reuse `LOCAL_AI_*` when unset. | reuse primary `LOCAL_AI_*` |
| `BACKUP_CIRCUIT_THRESHOLD` | Consecutive primary failures before opening the breaker. | `3` |
| `BACKUP_CIRCUIT_COOLDOWN_MS` | How long the breaker stays open. | `60000` |

**Reuse-with-override resolution:** for `BACKUP_AI_PROVIDER=X`, the backup's
credentials/model come from `BACKUP_X_*` if set, else fall back to the primary's
`X_*` env. This makes "primary grok, backup Anthropic" a two-line config
(`BACKUP_AI_PROVIDER=anthropic` + an existing `ANTHROPIC_API_KEY`), while still
supporting a distinct model/key/endpoint of the same type as the primary.

**Validation (fail fast at boot, mirroring the primary checks):** when
`BACKUP_AI_PROVIDER` is set, require the resolved credentials for that type:
- `anthropic` ⇒ resolved Anthropic API key present.
- `openai` ⇒ resolved OpenAI API key present.
- `openai-compatible` ⇒ resolved base URL **and** model present.

`Config` (`src/types.ts`) gains: `backupAiProvider?`, the resolved backup
fields, `primaryAiTimeoutMs: number`, `backupCircuitThreshold: number`,
`backupCircuitCooldownMs: number`.

## Interaction with the job runner

Per-call failover nests **inside** the existing job-level retry. If the backup
also fails transiently, `review()` throws transient → `handlePullRequest`
rethrows → `runReviewJob` retries the whole pipeline (attempt 2), which again
tries primary→backup. The circuit breaker makes those retries efficient: an open
breaker sends the retry straight to the backup instead of re-eating the primary
stall. No change to `jobs.ts` retry logic is required beyond the
`isTransientError` import move.

## Failure modes & edge cases

- **Backup itself times out / errors:** rethrow the backup error → existing
  retry/dead-letter path. No regression vs. today.
- **Backup output fails to parse:** `parseReviewResponse` already tolerant;
  a genuine parse failure surfaces via the existing parse-failure banner path,
  same as a primary parse failure.
- **Auth misconfig on primary (401/403):** does not fail over, does not trip the
  breaker; surfaces loudly (so ops notices the bad key) exactly as today.
- **No backup configured:** `this.ai` is the plain primary with the full 60s
  timeout — byte-for-byte current behavior.
- **Same-type, same-model backup:** cost accounting collapses them (identical
  provider+model) — harmless; logs still show `servedBy`.
- **Breaker state is per-process, in-memory:** resets on restart. Acceptable —
  it's a cost/latency guard, not a correctness mechanism.

## Testing strategy

No unit harness exists around `reviewer.reviewPR`; test the wrapper in isolation.

**`src/ai/failover.test.ts`** — fake `AIProvider` stubs (spies on all five
methods):
- Primary success ⇒ backup never called; result returned.
- Primary transient error (`AiTimeoutError`, 503, `ECONNRESET`) ⇒ backup called;
  backup result returned; `servedBy === "backup"` on `review`.
- Primary 401/403 ⇒ backup **not** called; error rethrown; breaker untouched.
- Both fail ⇒ throws the **backup** error.
- Breaker opens after `threshold` consecutive failover-eligible failures ⇒
  subsequent call skips primary, hits backup directly.
- Breaker half-open probe after cooldown: primary success closes it; failure
  re-opens. (Inject a clock so cooldown is testable without real time.)
- Primary success resets `consecutiveFailures`.
- All five methods delegate to the correct inner method with the same args.

**`src/ai/transient.test.ts`** — the extracted predicate keeps its current
classifications (port the relevant assertions from any existing `jobs`/
`isTransientError` coverage; add cases for `AiTimeoutError`, 500, 429, 401→false,
400→false).

**Config tests** — `BACKUP_AI_PROVIDER` unset ⇒ no backup fields / failover off;
set with reuse ⇒ resolves primary env; set with overrides ⇒ resolves overrides;
missing required backup credential ⇒ throws at `loadConfig`.

**Clock injection:** `FailoverProvider` takes an optional `now: () => number`
(default `Date.now`) so breaker timing is deterministic in tests.

## Files to touch

| File | Change |
|------|--------|
| `src/ai/transient.ts` | **New.** Extract `isTransientError` + helpers. |
| `src/realtime/jobs.ts` | Import `isTransientError` from `../ai/transient.js` (drop local copy). Re-export if any test imports it from here. |
| `src/ai/failover.ts` | **New.** `FailoverProvider` + circuit breaker. |
| `src/ai/provider-factory.ts` | **New** (or private in reviewer). `buildProvider(spec)`. |
| `src/config.ts` | Parse + validate backup env; resolve reuse/override; `primaryAiTimeoutMs`, breaker knobs. |
| `src/types.ts` | `Config` backup fields; `ReviewResult.servedBy?`. |
| `src/reviewer.ts` | Use `buildProvider`; conditionally wrap in `FailoverProvider`; append backup footnote when `servedBy === "backup"`. |
| `src/ai/failover.test.ts` | **New.** Wrapper unit tests. |
| `src/ai/transient.test.ts` | **New.** Predicate tests. |
| `test/…config…` | Backup config parse/validate tests (match existing config test location). |
| `.env.example` | Document the new `BACKUP_*` / `PRIMARY_AI_TIMEOUT_MS` vars. |
| `README` / relevant docs | Short "backup provider / failover" section. |

## Out of scope

- Changing the operational mitigation (raising `AI_REQUEST_TIMEOUT_MS`, retry
  scoping) — that is lever 1, tracked separately.
- Concurrent/hedged requests (running primary and backup in parallel). Sequential
  only, by decision #2/#6.
- Persisting breaker state across restarts.
- A third+ provider chain. Two-provider (primary + one backup) only.

## Success criteria

- With `BACKUP_AI_PROVIDER` unset, behavior is unchanged (all existing tests
  pass; primary keeps the 60s deadline).
- With a backup configured, a primary transient failure (incl. a primary
  short-timeout) results in a backup-served review rather than a dead-letter.
- A primary 401/403 surfaces without silently routing to the backup.
- A persistently-down primary opens the breaker and stops paying the primary
  stall on every review.
- `tsc --noEmit` clean, `npm test` green, `npm run lint` clean.
