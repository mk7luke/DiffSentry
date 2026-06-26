// ─────────────────────────────────────────────────────────────────────────────
// Bounded timeouts for AI provider calls.
//
// Every model call (Anthropic, OpenAI, OpenAI-compatible) runs inside
// `withAiTimeout`, which guarantees the call cannot hang forever:
//
//   - It hands an `AbortSignal` to the SDK so the in-flight HTTP request is
//     actually canceled when the deadline passes (both `@anthropic-ai/sdk` and
//     `openai` accept `{ signal }` in their per-request options). This frees the
//     socket instead of leaking it.
//   - It also races the call against a timer (`Promise.race`), so even an SDK
//     that ignored the signal still rejects on time.
//
// On timeout it rejects with a typed `AiTimeoutError`. The reviewer's error path
// (reviewer.ts) catches it, marks the review `failed` with the error message,
// and emits `review.failed` — a visible "review failed (AI timeout)" outcome
// rather than a silent hang or a fabricated "no concerns" result. Because the
// throw happens *before* the call's `track()`/usage recording runs, no cost
// event is written for a timed-out call, so cost accounting is never corrupted.
// ─────────────────────────────────────────────────────────────────────────────

/** Fallback request timeout used when config doesn't supply one. */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Thrown when an AI provider call exceeds its deadline. Typed (not a bare
 * `Error`) so callers can distinguish a timeout from any other provider failure
 * via `isAiTimeoutError`.
 */
export class AiTimeoutError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(provider: string, operation: string, timeoutMs: number) {
    super(`AI request timed out after ${timeoutMs}ms (${provider} ${operation})`);
    // Restore the prototype chain: when this class is down-leveled (e.g. an ES5
    // target), `super(...)` resets the prototype to `Error.prototype`, which
    // would break `instanceof AiTimeoutError`. Explicitly re-pin it so
    // `isAiTimeoutError` stays reliable regardless of compile target.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "AiTimeoutError";
    this.provider = provider;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export function isAiTimeoutError(err: unknown): err is AiTimeoutError {
  return err instanceof AiTimeoutError;
}

/**
 * Run `fn` with a bounded deadline. `fn` receives an `AbortSignal` it should
 * forward to the SDK so the underlying request is canceled on timeout.
 *
 * A non-finite or non-positive `timeoutMs` disables the bound (escape hatch);
 * the signal is still provided but never fires.
 */
export async function withAiTimeout<T>(
  opts: { provider: string; operation: string; timeoutMs: number },
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { provider, operation, timeoutMs } = opts;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fn(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Cancel the in-flight request, then reject with a typed error. The abort
      // and the rejection happen in the same tick, so the race settles on
      // AiTimeoutError before the SDK's abort error can surface.
      controller.abort();
      reject(new AiTimeoutError(provider, operation, timeoutMs));
    }, timeoutMs);
    // Don't keep the event loop alive just for the timeout.
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    // If `fn` settled before the deadline fired, the controller is still "live".
    // Abort it so any downstream work bound to the shared signal is canceled
    // consistently. (The timeout path already aborted, hence the guard.)
    if (!controller.signal.aborted) controller.abort();
  }
}
