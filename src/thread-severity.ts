import type { CommentSeverity } from "./types.js";

/**
 * Severity is decided at review time but lost once a finding becomes a GitHub
 * review thread — nothing in the rendered body is machine-readable on the way
 * back. Stamping it as a hidden HTML comment lets `summarizeReviewThreads` tell
 * an unresolved `critical` apart from an unresolved nitpick, which is what
 * makes severity-gated commit statuses possible.
 *
 * This module owns the wire format for both sides. It deliberately depends on
 * nothing but the severity type: `src/github.ts` reads markers and must not
 * import the AI layer that writes them.
 */
export const VALID_SEVERITIES: readonly CommentSeverity[] = ["critical", "major", "minor", "trivial"];

/** Severities that gate the `DiffSentry` commit status. */
const BLOCKING: readonly CommentSeverity[] = ["critical", "major"];

const MARKER_KEY = "diffsentry-severity";

/**
 * Footer every DiffSentry review comment carries. Predates the severity marker,
 * so it is the one reliable way to recognise a DiffSentry thread posted before
 * severities were stamped — which matters because `isOurBotThread` deliberately
 * matches any `*[bot]` login, and a second review bot's comment must not be
 * mistaken for an unreadable DiffSentry finding.
 */
export const DIFFSENTRY_COMMENT_FOOTER = "<!-- This is an auto-generated reply by DiffSentry -->";

/** Whether a body was authored by DiffSentry, marker or not. */
export function isDiffSentryComment(body: string): boolean {
  return body.includes(DIFFSENTRY_COMMENT_FOOTER);
}

/** Tolerant of the whitespace GitHub's markdown pipeline may normalise. */
const MARKER_RE = new RegExp(`<!--\\s*${MARKER_KEY}:\\s*([a-z]+)\\s*-->`, "gi");

export function renderSeverityMarker(severity: CommentSeverity): string {
  return `<!-- ${MARKER_KEY}:${severity} -->`;
}

/**
 * Severity of the finding a review-thread body represents, or `undefined` when
 * the body carries no readable marker — which is every thread posted before
 * this shipped. Callers treat `undefined` as blocking.
 *
 * The *last* marker wins: `formatCommentBody` always appends the real one after
 * the finding's prose, so a marker quoted inside that prose cannot outrank it.
 */
export function parseThreadSeverity(body: string): CommentSeverity | undefined {
  if (!body) return undefined;
  let found: CommentSeverity | undefined;
  for (const m of body.matchAll(MARKER_RE)) {
    const candidate = m[1].toLowerCase() as CommentSeverity;
    if (VALID_SEVERITIES.includes(candidate)) found = candidate;
  }
  return found;
}

/** Unknown severity blocks: an unreadable thread must never read as green. */
export function isBlockingSeverity(severity: CommentSeverity | undefined): boolean {
  return severity === undefined || BLOCKING.includes(severity);
}

const FINGERPRINT_KEY = "diffsentry-fingerprint";

/**
 * The dedup fingerprint, stamped the same way and for the same reason as the
 * severity: it has to survive the round trip through GitHub so a thread can be
 * matched back to the finding that produced it.
 *
 * Read by `resolveAddressedThreads`, so that closing a thread on nothing more
 * than "the file was touched" also retires its fingerprint — otherwise
 * cross-review dedup suppresses the next pass's re-raise and a finding nobody
 * addressed disappears from the PR.
 */
export function renderFingerprintMarker(fingerprint: string): string {
  return `<!-- ${FINGERPRINT_KEY}:${fingerprint} -->`;
}

/** Hex digest from `fingerprintFor`; anything else isn't one of ours. */
const FINGERPRINT_RE = new RegExp(`<!--\\s*${FINGERPRINT_KEY}:\\s*([0-9a-f]+)\\s*-->`, "gi");

/** Last marker wins, matching `parseThreadSeverity` — see its note on quoting. */
export function parseThreadFingerprint(body: string): string | undefined {
  if (!body) return undefined;
  let found: string | undefined;
  for (const m of body.matchAll(FINGERPRINT_RE)) found = m[1].toLowerCase();
  return found;
}
