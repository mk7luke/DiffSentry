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
