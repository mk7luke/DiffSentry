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
