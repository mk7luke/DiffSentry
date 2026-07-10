# Backup AI Provider / Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the primary review model fails transiently or hangs, DiffSentry falls back to a configured secondary provider and still posts a review, instead of dead-lettering it.

**Architecture:** A new `FailoverProvider implements AIProvider` wraps a primary and a backup provider; each of the five interface methods tries the primary (on a deliberately short deadline) and, on a transient error, falls over to the backup (on the normal deadline). An in-memory circuit breaker skips a persistently-down primary. The wrapper is built in the `Reviewer` constructor only when `BACKUP_AI_PROVIDER` is set — feature off by default.

**Tech Stack:** TypeScript (NodeNext, `.js`-suffixed relative imports mapping to `.ts`), Vitest (`tests/unit/**/*.test.ts`), Express app.

## Global Constraints

- Feature is **off by default**: unset `BACKUP_AI_PROVIDER` ⇒ `Reviewer` uses the plain primary provider with the full `AI_REQUEST_TIMEOUT_MS` (byte-for-byte current behavior).
- Relative imports MUST carry a `.js` extension (e.g. `import { x } from "./transient.js"`), per the repo's NodeNext style.
- Test files live under `tests/unit/`; import source as `../../src/...js`.
- Failover fires **only** on transient errors (`AiTimeoutError`, transient network codes, HTTP `>= 500`, `429`). It MUST NOT fire on 4xx (401/403/400). The circuit breaker MUST NOT count non-failover errors.
- Failover is **sequential** (primary awaited to completion/rejection before backup). Never run both concurrently.
- Commands: build `npm run build`, test `npm test`, lint `npm run lint`, typecheck `npx tsc --noEmit`.
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Extract the transient-error predicate into a shared module

Move `isTransientError` (and its private helpers) out of `src/realtime/jobs.ts` into a neutral `src/ai/transient.ts` so both the job runner and the failover wrapper share one definition. Behavior is unchanged.

**Files:**
- Create: `src/ai/transient.ts`
- Create: `tests/unit/transient.test.ts`
- Modify: `src/realtime/jobs.ts` (remove the local copy; import + re-export from the new module)

**Interfaces:**
- Produces: `export function isTransientError(err: unknown): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isTransientError } from "../../src/ai/transient.js";
import { AiTimeoutError } from "../../src/ai/timeout.js";

describe("isTransientError", () => {
  it("treats an AiTimeoutError as transient", () => {
    expect(isTransientError(new AiTimeoutError("openai-compatible", "review", 20000))).toBe(true);
  });

  it("treats transient network codes as transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("treats HTTP 5xx and 429 as transient", () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
  });

  it("does NOT treat auth/4xx as transient", () => {
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 403 })).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
  });

  it("treats AbortError / TimeoutError names as transient", () => {
    expect(isTransientError({ name: "AbortError" })).toBe(true);
    expect(isTransientError({ name: "TimeoutError" })).toBe(true);
  });

  it("matches transient message hints", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("service unavailable"))).toBe(true);
  });

  it("treats an ordinary error as non-transient", () => {
    expect(isTransientError(new Error("bad request: invalid model"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/transient.test.ts`
Expected: FAIL — cannot resolve `../../src/ai/transient.js`.

- [ ] **Step 3: Create the shared module**

Create `src/ai/transient.ts` by moving the block from `src/realtime/jobs.ts` verbatim (currently `TRANSIENT_CODES`, `TRANSIENT_MESSAGE_HINTS`, `statusOf`, and `isTransientError`, roughly `jobs.ts:68–122`):

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared classification of "transient" AI/network errors — worth a retry or a
// failover, as opposed to a deterministic 4xx that will just fail again.
//
// Used by the job runner (bounded retry / dead-letter) AND the FailoverProvider
// (primary → backup). Keeping one definition prevents the two from drifting.
// ─────────────────────────────────────────────────────────────────────────────

/** Network-layer error codes that warrant a retry / failover. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_MESSAGE_HINTS = [
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "socket hang up",
  "network",
  "fetch failed",
  "temporarily unavailable",
  "service unavailable",
  "rate limit",
  "too many requests",
];

/** Read an HTTP-ish status off an error (Octokit RequestError, fetch wrappers). */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
  return typeof s === "number" ? s : undefined;
}

/**
 * Classify an error as transient (worth retrying / failing over) or permanent
 * (fail fast). Transient = network blips, GitHub/AI 5xx + 429, request timeouts,
 * and AbortError raised by an AI client's own timeout. NOTE: a cancel/abort from
 * our own cancel path never reaches these callers, so a thrown AbortError here is
 * an upstream timeout, not a cancellation.
 */
export function isTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;

  const status = statusOf(err);
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;

  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_MESSAGE_HINTS.some((hint) => msg.includes(hint));
}
```

- [ ] **Step 4: Update `jobs.ts` to import from the shared module**

In `src/realtime/jobs.ts`, delete the moved block (`TRANSIENT_CODES`, `TRANSIENT_MESSAGE_HINTS`, `statusOf`, and the `isTransientError` function + its doc comment). Add at the top with the other imports:

```ts
import { isTransientError } from "../ai/transient.js";
```

Then re-export it so any current/future importer of `jobs.ts` keeps working:

```ts
export { isTransientError } from "../ai/transient.js";
```

Leave the rest of `jobs.ts` (retry loop, `errorMessage`, `sleep`, etc.) unchanged.

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx vitest run tests/unit/transient.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/ai/transient.ts src/realtime/jobs.ts tests/unit/transient.test.ts
git commit -m "Extract isTransientError into shared src/ai/transient.ts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `FailoverProvider` + circuit breaker

The wrapper. Implements all five `AIProvider` methods; tries primary then backup on transient errors; opens a breaker after N consecutive failover-eligible primary failures.

**Files:**
- Create: `src/ai/failover.ts`
- Create: `tests/unit/failover.test.ts`
- Modify: `src/types.ts` (add `ReviewResult.servedBy?`)

**Interfaces:**
- Consumes: `isTransientError` (Task 1); `AIProvider`, `ReviewResult`, `WalkthroughResult`, `PRContext`, `IssueContext`, `RepoConfig`, `Learning` from `../types.js`.
- Produces:
  ```ts
  export interface FailoverOptions { circuitThreshold: number; circuitCooldownMs: number; now?: () => number; }
  export class FailoverProvider implements AIProvider { constructor(primary: AIProvider, backup: AIProvider, opts: FailoverOptions); /* five methods */ }
  ```
- Produces (types): `ReviewResult.servedBy?: "primary" | "backup"`.

- [ ] **Step 1: Add the `servedBy` field to `ReviewResult`**

In `src/types.ts`, inside `export interface ReviewResult` (after `fanInByFile?`), add:

```ts
  /** Which provider produced this review. Set to "backup" by FailoverProvider
   *  when the primary failed over; absent/"primary" otherwise. Drives the
   *  subtle "reviewed by backup provider" footnote in the posted body. */
  servedBy?: "primary" | "backup";
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/failover.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FailoverProvider } from "../../src/ai/failover.js";
import { AiTimeoutError } from "../../src/ai/timeout.js";
import type { AIProvider, ReviewResult, PRContext, RepoConfig } from "../../src/types.js";

function ctx(): PRContext {
  return {
    owner: "o", repo: "r", pullNumber: 1, title: "t", description: "",
    baseBranch: "main", headBranch: "feat", headSha: "sha", files: [], diff: "",
  } as unknown as PRContext;
}

function review(summary: string): ReviewResult {
  return { summary, comments: [], approval: "COMMENT" };
}

/** Minimal fake provider; only the methods a test exercises are stubbed. */
function fakeProvider(over: Partial<AIProvider>): AIProvider {
  const notImpl = () => { throw new Error("not stubbed"); };
  return {
    review: over.review ?? (notImpl as AIProvider["review"]),
    generateWalkthrough: over.generateWalkthrough ?? (notImpl as AIProvider["generateWalkthrough"]),
    chat: over.chat ?? (notImpl as AIProvider["chat"]),
    chatIssue: over.chatIssue ?? (notImpl as AIProvider["chatIssue"]),
    complete: over.complete ?? (notImpl as AIProvider["complete"]),
  };
}

const OPTS = { circuitThreshold: 3, circuitCooldownMs: 60_000 };

describe("FailoverProvider", () => {
  it("returns the primary result and never calls the backup on success", async () => {
    const backupReview = vi.fn();
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockResolvedValue(review("primary")) }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    const res = await p.review(ctx());
    expect(res.summary).toBe("primary");
    expect(res.servedBy).toBeUndefined();
    expect(backupReview).not.toHaveBeenCalled();
  });

  it("fails over to the backup on a transient primary error and tags servedBy", async () => {
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000)) }),
      fakeProvider({ review: vi.fn().mockResolvedValue(review("backup")) }),
      OPTS,
    );
    const res = await p.review(ctx());
    expect(res.summary).toBe("backup");
    expect(res.servedBy).toBe("backup");
  });

  it("does NOT fail over on a 401 and rethrows", async () => {
    const backupReview = vi.fn();
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 })) }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    await expect(p.review(ctx())).rejects.toThrow("unauthorized");
    expect(backupReview).not.toHaveBeenCalled();
  });

  it("rethrows the backup error when both fail", async () => {
    const p = new FailoverProvider(
      fakeProvider({ review: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000)) }),
      fakeProvider({ review: vi.fn().mockRejectedValue(new Error("backup down")) }),
      OPTS,
    );
    await expect(p.review(ctx())).rejects.toThrow("backup down");
  });

  it("opens the breaker after threshold consecutive transient failures, then routes straight to backup", async () => {
    const primaryReview = vi.fn().mockRejectedValue(new AiTimeoutError("primary", "review", 20000));
    const backupReview = vi.fn().mockResolvedValue(review("backup"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    // 3 failing-then-failover calls trip the breaker.
    await p.review(ctx());
    await p.review(ctx());
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(3);
    // 4th call: breaker open → primary skipped entirely.
    await p.review(ctx());
    expect(primaryReview).toHaveBeenCalledTimes(3);
    expect(backupReview).toHaveBeenCalledTimes(4);
  });

  it("half-opens after cooldown; a primary success closes the breaker", async () => {
    let clock = 1_000;
    const now = () => clock;
    const primaryReview = vi
      .fn()
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockResolvedValue(review("primary-recovered"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: vi.fn().mockResolvedValue(review("backup")) }),
      { ...OPTS, now },
    );
    await p.review(ctx()); await p.review(ctx()); await p.review(ctx()); // breaker opens
    clock += 60_001; // cooldown elapsed → half-open probe hits primary
    const res = await p.review(ctx());
    expect(res.summary).toBe("primary-recovered");
    expect(res.servedBy).toBeUndefined(); // primary served
  });

  it("resets consecutive failures on a primary success", async () => {
    const primaryReview = vi
      .fn()
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockRejectedValueOnce(new AiTimeoutError("primary", "review", 20000))
      .mockResolvedValueOnce(review("ok"))       // resets counter
      .mockRejectedValue(new AiTimeoutError("primary", "review", 20000));
    const backupReview = vi.fn().mockResolvedValue(review("backup"));
    const p = new FailoverProvider(
      fakeProvider({ review: primaryReview }),
      fakeProvider({ review: backupReview }),
      OPTS,
    );
    await p.review(ctx()); await p.review(ctx()); // 2 failures
    await p.review(ctx());                        // success → reset
    await p.review(ctx());                        // 1 failure (breaker still closed)
    expect(primaryReview).toHaveBeenCalledTimes(4); // primary always attempted (never skipped)
  });

  it("delegates the non-review methods and fails them over too", async () => {
    const p = new FailoverProvider(
      fakeProvider({
        generateWalkthrough: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "walkthrough", 20000)),
        chat: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "chat", 20000)),
        chatIssue: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "issue_chat", 20000)),
        complete: vi.fn().mockRejectedValue(new AiTimeoutError("primary", "complete", 20000)),
      }),
      fakeProvider({
        generateWalkthrough: vi.fn().mockResolvedValue({ summary: "wt", fileDescriptions: [] }),
        chat: vi.fn().mockResolvedValue("chat-backup"),
        chatIssue: vi.fn().mockResolvedValue("issue-backup"),
        complete: vi.fn().mockResolvedValue("complete-backup"),
      }),
      OPTS,
    );
    expect((await p.generateWalkthrough(ctx())).summary).toBe("wt");
    expect(await p.chat(ctx(), "hi")).toBe("chat-backup");
    expect(await p.chatIssue({} as never, "hi")).toBe("issue-backup");
    expect(await p.complete("sys", "usr")).toBe("complete-backup");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/failover.test.ts`
Expected: FAIL — cannot resolve `../../src/ai/failover.js`.

- [ ] **Step 4: Implement `FailoverProvider`**

Create `src/ai/failover.ts`:

```ts
import {
  AIProvider,
  PRContext,
  ReviewResult,
  WalkthroughResult,
  RepoConfig,
  Learning,
  IssueContext,
} from "../types.js";
import { isTransientError } from "./transient.js";
import { logger } from "../logger.js";

export interface FailoverOptions {
  /** Consecutive failover-eligible primary failures before the breaker opens. */
  circuitThreshold: number;
  /** How long (ms) the breaker stays open, routing straight to the backup. */
  circuitCooldownMs: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential try-primary-then-backup wrapper around two AIProviders.
//
//   - Fails over ONLY on transient errors (isTransientError): timeouts, 5xx,
//     429, network blips. A 4xx (auth / bad request) rethrows without touching
//     the backup or the breaker — a bad primary key must surface, not silently
//     route all traffic to the backup.
//   - The primary is constructed with a SHORT deadline and the backup with the
//     normal one (see reviewer.ts), so a slow-hang on the primary switches fast.
//   - A circuit breaker skips a persistently-down primary for a cooldown so we
//     don't pay the primary's stall on every single review during an outage.
//
// State is in-memory on the instance (the Reviewer is effectively a singleton),
// so it persists across reviews within a process and resets on restart — it is a
// cost/latency guard, not a correctness mechanism.
// ─────────────────────────────────────────────────────────────────────────────
export class FailoverProvider implements AIProvider {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly primary: AIProvider,
    private readonly backup: AIProvider,
    opts: FailoverOptions,
  ) {
    this.threshold = opts.circuitThreshold;
    this.cooldownMs = opts.circuitCooldownMs;
    this.now = opts.now ?? Date.now;
  }

  /** True while the breaker is open and the cooldown has not yet elapsed. Once
   *  the cooldown passes we return false so the next call probes the primary
   *  (half-open). */
  private breakerOpen(): boolean {
    if (this.openedAt === null) return false;
    return this.now() - this.openedAt < this.cooldownMs;
  }

  private recordPrimarySuccess(): void {
    if (this.openedAt !== null || this.consecutiveFailures > 0) {
      logger.info({ mode: "failover" }, "Primary AI provider recovered — closing circuit breaker");
    }
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private recordPrimaryFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      const wasOpen = this.openedAt !== null;
      this.openedAt = this.now();
      if (!wasOpen) {
        logger.warn(
          { mode: "failover", consecutiveFailures: this.consecutiveFailures },
          "Primary AI provider failing repeatedly — opening circuit breaker (routing to backup)",
        );
      }
    }
  }

  /**
   * Run one operation with failover. Returns the result plus which provider
   * served it. Never runs primary and backup concurrently.
   */
  private async run<T>(
    operation: string,
    primaryCall: () => Promise<T>,
    backupCall: () => Promise<T>,
  ): Promise<{ result: T; servedBy: "primary" | "backup" }> {
    if (this.breakerOpen()) {
      logger.warn({ mode: "failover", operation }, "Circuit breaker open — routing directly to backup AI provider");
      return { result: await backupCall(), servedBy: "backup" };
    }

    const startedAt = this.now();
    try {
      const result = await primaryCall();
      this.recordPrimarySuccess();
      return { result, servedBy: "primary" };
    } catch (err) {
      if (!isTransientError(err)) {
        // Deterministic failure (e.g. 401/403/400) — do NOT fail over and do
        // NOT trip the breaker; surface it so misconfiguration is visible.
        throw err;
      }
      this.recordPrimaryFailure();
      logger.warn(
        { mode: "failover", operation, primaryLatencyMs: this.now() - startedAt, err },
        "Primary AI provider failed transiently — failing over to backup",
      );
      return { result: await backupCall(), servedBy: "backup" };
    }
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { result, servedBy } = await this.run(
      "review",
      () => this.primary.review(context, repoConfig, learnings),
      () => this.backup.review(context, repoConfig, learnings),
    );
    return servedBy === "backup" ? { ...result, servedBy } : result;
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { result } = await this.run(
      "walkthrough",
      () => this.primary.generateWalkthrough(context, repoConfig),
      () => this.backup.generateWalkthrough(context, repoConfig),
    );
    return result;
  }

  async chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { result } = await this.run(
      "chat",
      () => this.primary.chat(context, userMessage, repoConfig),
      () => this.backup.chat(context, userMessage, repoConfig),
    );
    return result;
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { result } = await this.run(
      "issue_chat",
      () => this.primary.chatIssue(context, userMessage, repoConfig),
      () => this.backup.chatIssue(context, userMessage, repoConfig),
    );
    return result;
  }

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const { result } = await this.run(
      "complete",
      () => this.primary.complete(system, user, opts),
      () => this.backup.complete(system, user, opts),
    );
    return result;
  }
}
```

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `npx vitest run tests/unit/failover.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors. (If `PRContext`/`IssueContext` fields in the test's `ctx()` cast cause a type error, keep the `as unknown as PRContext` cast — the wrapper never inspects the context.)

- [ ] **Step 6: Commit**

```bash
git add src/ai/failover.ts tests/unit/failover.test.ts src/types.ts
git commit -m "Add FailoverProvider with circuit breaker (primary → backup AI)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Provider factory + backup config parsing/validation

Extract provider construction into a reusable `buildProvider(spec)`, and teach `loadConfig` to parse + validate the backup provider (reuse-with-override) plus the short primary deadline and breaker knobs.

**Files:**
- Create: `src/ai/provider-factory.ts`
- Modify: `src/types.ts` (add `Config` fields)
- Modify: `src/config.ts` (parse/validate + resolve)
- Create: `tests/unit/config-backup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderSpec {
    provider: "anthropic" | "openai" | "openai-compatible";
    anthropicApiKey?: string; anthropicModel: string; anthropicBaseUrl?: string;
    openaiApiKey?: string; openaiModel: string; openaiBaseUrl?: string;
    localAiBaseUrl?: string; localAiApiKey?: string; localAiModel: string; localAiJsonMode: boolean;
    timeoutMs: number; label?: string;
  }
  export function buildProvider(spec: ProviderSpec): AIProvider;
  ```
- Produces (Config additions): `backupAiProvider?`, resolved `backup*` fields, `primaryAiTimeoutMs: number`, `backupCircuitThreshold: number`, `backupCircuitCooldownMs: number`.

- [ ] **Step 1: Create the provider factory**

Create `src/ai/provider-factory.ts`:

```ts
import { AIProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** A fully-resolved recipe for one provider. Both the primary and the backup
 *  are built from one of these, so construction lives in exactly one place. */
export interface ProviderSpec {
  provider: "anthropic" | "openai" | "openai-compatible";
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseUrl?: string;
  localAiBaseUrl?: string;
  localAiApiKey?: string;
  localAiModel: string;
  localAiJsonMode: boolean;
  timeoutMs: number;
  /** Overrides the openai-compatible provider label (for cost/log attribution
   *  when a same-type backup would otherwise collide with the primary). */
  label?: string;
}

export function buildProvider(spec: ProviderSpec): AIProvider {
  if (spec.provider === "anthropic") {
    return new AnthropicProvider(spec.anthropicApiKey!, spec.anthropicModel, spec.anthropicBaseUrl, spec.timeoutMs);
  }
  if (spec.provider === "openai-compatible") {
    return new OpenAICompatibleProvider({
      baseURL: spec.localAiBaseUrl!,
      model: spec.localAiModel,
      apiKey: spec.localAiApiKey,
      jsonMode: spec.localAiJsonMode,
      timeoutMs: spec.timeoutMs,
      providerLabel: spec.label,
    });
  }
  return new OpenAIProvider(spec.openaiApiKey!, spec.openaiModel, spec.openaiBaseUrl, spec.timeoutMs);
}
```

- [ ] **Step 2: Add the new `Config` fields**

In `src/types.ts`, inside `export interface Config` near the existing AI fields (`aiRequestTimeoutMs: number;`), add:

```ts
  // ─── Backup AI provider / failover (all optional; off unless backupAiProvider set) ───
  /** When set, wrap the primary provider in a FailoverProvider with this backup. */
  backupAiProvider?: "anthropic" | "openai" | "openai-compatible";
  backupAnthropicApiKey?: string;
  backupAnthropicModel?: string;
  backupAnthropicBaseUrl?: string;
  backupOpenaiApiKey?: string;
  backupOpenaiModel?: string;
  backupOpenaiBaseUrl?: string;
  backupLocalAiBaseUrl?: string;
  backupLocalAiApiKey?: string;
  backupLocalAiModel?: string;
  backupLocalAiJsonMode?: boolean;
  /** Short per-op deadline for the PRIMARY when a backup is configured, so a
   *  slow-hang fails over quickly. Ignored (primary uses aiRequestTimeoutMs)
   *  when no backup is set. */
  primaryAiTimeoutMs: number;
  /** Consecutive primary failures before the failover breaker opens. */
  backupCircuitThreshold: number;
  /** How long (ms) the failover breaker stays open. */
  backupCircuitCooldownMs: number;
```

- [ ] **Step 3: Write the failing config test**

Create `tests/unit/config-backup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

// loadConfig requires the core GitHub vars; set a minimal valid baseline and
// vary only the AI/backup vars per test. We snapshot + restore process.env.
const BASE: Record<string, string> = {
  GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  AI_PROVIDER: "openai-compatible",
  LOCAL_AI_BASE_URL: "http://localhost:1234/v1",
  LOCAL_AI_MODEL: "grok-4.5",
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
  // Fresh env containing only what each test sets (plus BASE).
  process.env = { ...BASE } as NodeJS.ProcessEnv;
});
afterEach(() => {
  process.env = saved;
});

describe("backup provider config", () => {
  it("is off by default (no BACKUP_AI_PROVIDER)", () => {
    const cfg = loadConfig();
    expect(cfg.backupAiProvider).toBeUndefined();
  });

  it("reuses primary env when only BACKUP_AI_PROVIDER is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-reused";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    const cfg = loadConfig();
    expect(cfg.backupAiProvider).toBe("anthropic");
    expect(cfg.backupAnthropicApiKey).toBe("sk-ant-reused");
  });

  it("prefers BACKUP_* overrides over primary env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-primary";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    process.env.BACKUP_ANTHROPIC_API_KEY = "sk-ant-backup";
    process.env.BACKUP_ANTHROPIC_MODEL = "claude-opus-4-8";
    const cfg = loadConfig();
    expect(cfg.backupAnthropicApiKey).toBe("sk-ant-backup");
    expect(cfg.backupAnthropicModel).toBe("claude-opus-4-8");
  });

  it("throws when the backup credential is missing", () => {
    process.env.BACKUP_AI_PROVIDER = "anthropic"; // no ANTHROPIC key anywhere
    expect(() => loadConfig()).toThrow(/BACKUP_AI_PROVIDER=anthropic/);
  });

  it("rejects an unknown BACKUP_AI_PROVIDER", () => {
    process.env.BACKUP_AI_PROVIDER = "claude";
    expect(() => loadConfig()).toThrow(/BACKUP_AI_PROVIDER/);
  });

  it("defaults the short primary timeout and breaker knobs", () => {
    process.env.ANTHROPIC_API_KEY = "sk";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    const cfg = loadConfig();
    expect(cfg.primaryAiTimeoutMs).toBe(20_000);
    expect(cfg.backupCircuitThreshold).toBe(3);
    expect(cfg.backupCircuitCooldownMs).toBe(60_000);
  });

  it("clamps the primary timeout to at most AI_REQUEST_TIMEOUT_MS", () => {
    process.env.ANTHROPIC_API_KEY = "sk";
    process.env.BACKUP_AI_PROVIDER = "anthropic";
    process.env.AI_REQUEST_TIMEOUT_MS = "15000";
    process.env.PRIMARY_AI_TIMEOUT_MS = "20000";
    const cfg = loadConfig();
    expect(cfg.primaryAiTimeoutMs).toBe(15_000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/unit/config-backup.test.ts`
Expected: FAIL — `backupAiProvider`/`primaryAiTimeoutMs` undefined and no validation.

- [ ] **Step 5: Implement config parsing/validation**

In `src/config.ts`, after the `aiRequestTimeoutMs` block (around line 83) and before the `ignoredPatterns` block, add:

```ts
  // ─── Backup AI provider (failover) — off unless BACKUP_AI_PROVIDER is set ───
  const backupRaw = process.env.BACKUP_AI_PROVIDER;
  let backupAiProvider: Config["backupAiProvider"];
  let backupAnthropicApiKey: string | undefined;
  let backupAnthropicModel: string | undefined;
  let backupAnthropicBaseUrl: string | undefined;
  let backupOpenaiApiKey: string | undefined;
  let backupOpenaiModel: string | undefined;
  let backupOpenaiBaseUrl: string | undefined;
  let backupLocalAiBaseUrl: string | undefined;
  let backupLocalAiApiKey: string | undefined;
  let backupLocalAiModel: string | undefined;
  let backupLocalAiJsonMode: boolean | undefined;

  if (backupRaw) {
    if (!isAiProvider(backupRaw)) {
      throw new Error(
        `BACKUP_AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")} (got: ${backupRaw})`
      );
    }
    backupAiProvider = backupRaw;

    // Reuse-with-override: BACKUP_* wins, else fall back to the primary's env.
    backupAnthropicApiKey = process.env.BACKUP_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    backupAnthropicModel = process.env.BACKUP_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    backupAnthropicBaseUrl = process.env.BACKUP_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    backupOpenaiApiKey = process.env.BACKUP_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    backupOpenaiModel = process.env.BACKUP_OPENAI_MODEL || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    backupOpenaiBaseUrl = process.env.BACKUP_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
    backupLocalAiBaseUrl = process.env.BACKUP_LOCAL_AI_BASE_URL || process.env.LOCAL_AI_BASE_URL;
    backupLocalAiApiKey = process.env.BACKUP_LOCAL_AI_API_KEY || process.env.LOCAL_AI_API_KEY;
    backupLocalAiModel = process.env.BACKUP_LOCAL_AI_MODEL || process.env.LOCAL_AI_MODEL || "";
    backupLocalAiJsonMode =
      (process.env.BACKUP_LOCAL_AI_JSON_MODE || process.env.LOCAL_AI_JSON_MODE || "true").toLowerCase() !== "false";

    // Fail fast if the resolved backup can't actually be constructed.
    if (backupAiProvider === "anthropic" && !backupAnthropicApiKey) {
      throw new Error("BACKUP_AI_PROVIDER=anthropic requires BACKUP_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY");
    }
    if (backupAiProvider === "openai" && !backupOpenaiApiKey) {
      throw new Error("BACKUP_AI_PROVIDER=openai requires BACKUP_OPENAI_API_KEY or OPENAI_API_KEY");
    }
    if (backupAiProvider === "openai-compatible" && (!backupLocalAiBaseUrl || !backupLocalAiModel)) {
      throw new Error(
        "BACKUP_AI_PROVIDER=openai-compatible requires BACKUP_LOCAL_AI_BASE_URL and BACKUP_LOCAL_AI_MODEL " +
          "(or the primary LOCAL_AI_BASE_URL / LOCAL_AI_MODEL to reuse)"
      );
    }
  }

  // Short primary deadline (only meaningful when a backup is configured). Clamp
  // to at most the normal bound so the primary is never given LONGER than the
  // overall per-op budget.
  const parsedPrimaryTimeout = parseInt(process.env.PRIMARY_AI_TIMEOUT_MS || "", 10);
  let primaryAiTimeoutMs = Number.isFinite(parsedPrimaryTimeout) ? parsedPrimaryTimeout : 20_000;
  if (aiRequestTimeoutMs > 0 && primaryAiTimeoutMs > aiRequestTimeoutMs) {
    primaryAiTimeoutMs = aiRequestTimeoutMs;
  }

  const parsedThreshold = parseInt(process.env.BACKUP_CIRCUIT_THRESHOLD || "", 10);
  const backupCircuitThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 1 ? parsedThreshold : 3;

  const parsedCooldown = parseInt(process.env.BACKUP_CIRCUIT_COOLDOWN_MS || "", 10);
  const backupCircuitCooldownMs = Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : 60_000;
```

Then add these to the returned `Config` object literal (after `aiRequestTimeoutMs,`):

```ts
    backupAiProvider,
    backupAnthropicApiKey,
    backupAnthropicModel,
    backupAnthropicBaseUrl,
    backupOpenaiApiKey,
    backupOpenaiModel,
    backupOpenaiBaseUrl,
    backupLocalAiBaseUrl,
    backupLocalAiApiKey,
    backupLocalAiModel,
    backupLocalAiJsonMode,
    primaryAiTimeoutMs,
    backupCircuitThreshold,
    backupCircuitCooldownMs,
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `npx vitest run tests/unit/config-backup.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/ai/provider-factory.ts src/config.ts src/types.ts tests/unit/config-backup.test.ts
git commit -m "Add provider factory and backup-provider config (off by default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire failover into the Reviewer + backup footnote

Use `buildProvider` in the `Reviewer` constructor, wrap in `FailoverProvider` when a backup is configured, and append the subtle "reviewed by backup" footnote to the posted body.

**Files:**
- Modify: `src/reviewer.ts` (constructor `211–223`; body assembly near `1372`; imports)

**Interfaces:**
- Consumes: `buildProvider`, `ProviderSpec` (Task 3); `FailoverProvider` (Task 2); `Config` backup fields (Task 3).

- [ ] **Step 1: Add imports**

At the top of `src/reviewer.ts`, alongside the existing provider imports, add:

```ts
import { buildProvider, ProviderSpec } from "./ai/provider-factory.js";
import { FailoverProvider } from "./ai/failover.js";
```

(Keep the existing `AnthropicProvider`/`OpenAIProvider`/`OpenAICompatibleProvider` imports only if still referenced elsewhere; if the constructor was their sole use, remove them to satisfy `noUnusedLocals`. Verify with `npx tsc --noEmit`.)

- [ ] **Step 2: Replace the constructor provider block**

In `src/reviewer.ts`, replace the `if (config.aiProvider === "anthropic") { … } else { … }` block (currently lines ~211–223) with:

```ts
    const primarySpec: ProviderSpec = {
      provider: config.aiProvider,
      anthropicApiKey: config.anthropicApiKey,
      anthropicModel: config.anthropicModel,
      anthropicBaseUrl: config.anthropicBaseUrl,
      openaiApiKey: config.openaiApiKey,
      openaiModel: config.openaiModel,
      openaiBaseUrl: config.openaiBaseUrl,
      localAiBaseUrl: config.localAiBaseUrl,
      localAiApiKey: config.localAiApiKey,
      localAiModel: config.localAiModel,
      localAiJsonMode: config.localAiJsonMode,
      // Short deadline ONLY when there's a backup to fail over to; otherwise the
      // primary keeps the full budget (unchanged behavior).
      timeoutMs: config.backupAiProvider ? config.primaryAiTimeoutMs : config.aiRequestTimeoutMs,
    };
    const primary = buildProvider(primarySpec);

    if (config.backupAiProvider) {
      const backupSpec: ProviderSpec = {
        provider: config.backupAiProvider,
        anthropicApiKey: config.backupAnthropicApiKey,
        anthropicModel: config.backupAnthropicModel ?? config.anthropicModel,
        anthropicBaseUrl: config.backupAnthropicBaseUrl,
        openaiApiKey: config.backupOpenaiApiKey,
        openaiModel: config.backupOpenaiModel ?? config.openaiModel,
        openaiBaseUrl: config.backupOpenaiBaseUrl,
        localAiBaseUrl: config.backupLocalAiBaseUrl,
        localAiApiKey: config.backupLocalAiApiKey,
        localAiModel: config.backupLocalAiModel ?? "",
        localAiJsonMode: config.backupLocalAiJsonMode ?? true,
        timeoutMs: config.aiRequestTimeoutMs,
        // Distinguish a same-type backup in cost/log attribution.
        label: config.backupAiProvider === "openai-compatible" ? "openai-compatible-backup" : undefined,
      };
      const backup = buildProvider(backupSpec);
      this.ai = new FailoverProvider(primary, backup, {
        circuitThreshold: config.backupCircuitThreshold,
        circuitCooldownMs: config.backupCircuitCooldownMs,
      });
      logger.info(
        { primary: config.aiProvider, backup: config.backupAiProvider },
        "AI failover enabled (primary → backup)",
      );
    } else {
      this.ai = primary;
    }
```

(If `logger` is not already imported in `reviewer.ts`, use the module's existing logging import; verify by grep. If none exists, add `import { logger } from "./logger.js";`.)

- [ ] **Step 3: Append the backup footnote to the review body**

In `src/reviewer.ts`, immediately after the statement that assigns
`reviewResult.summary = formatReviewBody(reviewResult, { … });` (ends around line 1395), add:

```ts
      if (reviewResult.servedBy === "backup") {
        reviewResult.summary +=
          "\n\n<sub>ℹ️ The primary review model was unavailable; this review was generated by the configured backup provider.</sub>";
      }
```

- [ ] **Step 4: Typecheck + full test suite + lint**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: PASS. In particular the pre-existing suite is green (no-backup path unchanged).

- [ ] **Step 5: Build to confirm the server compiles**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/reviewer.ts
git commit -m "Wire FailoverProvider into Reviewer; note backup-served reviews

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Documentation

Document the new env vars so operators can turn the feature on.

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (or the docs page covering AI provider config — grep for `AI_PROVIDER`)

- [ ] **Step 1: Add the backup block to `.env.example`**

After the existing AI provider / `AI_REQUEST_TIMEOUT_MS` section, add:

```bash
# ─── Backup AI provider / failover (optional; off unless BACKUP_AI_PROVIDER set) ───
# When the primary provider fails transiently (timeout, 5xx, 429, network), the
# review falls over to this backup so a review is still posted. Peer-quality
# backup recommended. Does NOT fail over on 401/403 (surfaces misconfiguration).
# BACKUP_AI_PROVIDER=anthropic          # "anthropic" | "openai" | "openai-compatible"
# Backup creds REUSE the matching primary vars unless a BACKUP_* override is set:
# BACKUP_ANTHROPIC_API_KEY=sk-ant-...    # else reuses ANTHROPIC_API_KEY
# BACKUP_ANTHROPIC_MODEL=claude-opus-4-8 # else reuses ANTHROPIC_MODEL
# BACKUP_ANTHROPIC_BASE_URL=             # else reuses ANTHROPIC_BASE_URL
# BACKUP_OPENAI_API_KEY=                 # else reuses OPENAI_API_KEY
# BACKUP_OPENAI_MODEL=                   # else reuses OPENAI_MODEL
# BACKUP_OPENAI_BASE_URL=                # else reuses OPENAI_BASE_URL
# BACKUP_LOCAL_AI_BASE_URL=              # else reuses LOCAL_AI_BASE_URL
# BACKUP_LOCAL_AI_MODEL=                 # else reuses LOCAL_AI_MODEL
# BACKUP_LOCAL_AI_API_KEY=               # else reuses LOCAL_AI_API_KEY
# BACKUP_LOCAL_AI_JSON_MODE=             # else reuses LOCAL_AI_JSON_MODE
#
# Short deadline given to the PRIMARY when a backup is configured, so a slow-hang
# fails over quickly (clamped to <= AI_REQUEST_TIMEOUT_MS). Default 20000.
# PRIMARY_AI_TIMEOUT_MS=20000
# Circuit breaker: after N consecutive primary failures, skip the primary for a
# cooldown and go straight to the backup.
# BACKUP_CIRCUIT_THRESHOLD=3
# BACKUP_CIRCUIT_COOLDOWN_MS=60000
```

- [ ] **Step 2: Add a short README section**

Find the provider-config docs: `grep -rn "AI_PROVIDER" README.md docs/`. In the AI-provider section, add a short "Backup provider / failover" subsection summarizing: off by default; set `BACKUP_AI_PROVIDER` to enable; reuse-with-override; fails over on transient errors only (not auth); primary gets a short deadline; circuit breaker guards a down primary. Keep it to a short paragraph + the key vars.

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md docs/
git commit -m "Document backup AI provider / failover env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Trigger policy (transient-only + short primary deadline) → Task 1 (predicate), Task 2 (`run`), Task 3 (`primaryAiTimeoutMs`), Task 4 (wiring). ✓
- All-five-methods per-call sequential failover → Task 2. ✓
- Peer-quality / output parity (fall through on backup failure) → Task 2 (`run` rethrows backup error). ✓
- Config reuse-with-override, off by default → Task 3. ✓
- Idempotency (sequential) → inherent in Task 2 `run`; no code needed. ✓
- Observability (structured logs, per-provider cost) → Task 2 logs + Task 4 `label`. ✓
- Circuit breaker → Task 2. ✓
- Review-body transparency note → Task 2 (`servedBy` field) + Task 4 (footnote). ✓
- Docs → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 5 Step 2 references a grep because README structure isn't pinned, but gives the exact content to add. ✓

**Type consistency:** `ProviderSpec` fields identical across Task 3 (definition) and Task 4 (construction). `FailoverOptions` (`circuitThreshold`, `circuitCooldownMs`, `now?`) consistent across Task 2 definition, tests, and Task 4 call site. `ReviewResult.servedBy` defined in Task 2, set in Task 2, read in Task 4. `isTransientError` signature consistent Task 1 ↔ Task 2. ✓
