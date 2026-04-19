import { gunzipSync, gzipSync } from "node:zlib";

const STATE_MARKER_START = "<!-- diffsentry-state:";
const STATE_MARKER_END = "-->";

/**
 * Persistent state attached to a PR's walkthrough comment so that
 * incremental reviews can self-recover after a bot restart and so that
 * we can surface "Files skipped because similar to previous changes" and
 * "Files skipped due to trivial changes" lists on subsequent runs.
 *
 * Encoded as a base64(gzip(JSON)) payload inside an HTML comment at the
 * tail of the walkthrough body — invisible to readers, intact on
 * round-trip through GitHub's markdown sanitizer.
 */
export interface WalkthroughState {
  /** Schema version for forward-compat. */
  v: 1;
  /** SHA of the head commit at the most recent review. */
  lastReviewedSha?: string;
  /** Map of file path → SHA when last reviewed (per-file granularity). */
  fileShas?: Record<string, string>;
  /** Inline-comment fingerprints already posted (for dedup). */
  postedFingerprints?: string[];
  /** Files we processed (passed path filters, had reviewable changes). */
  filesProcessed?: string[];
  /** Files skipped because their content matches the previously reviewed snapshot. */
  filesSkippedSimilar?: string[];
  /** Files skipped because the diff was trivial (whitespace/imports/comments only). */
  filesSkippedTrivial?: string[];
  /** Pre-merge check counts from the most recent run, for status delta. */
  preMergeCounts?: { passed: number; failed: number };
  /** ISO timestamp of when state was last persisted. */
  updatedAt?: string;
}

export function encodeState(state: WalkthroughState): string {
  const json = JSON.stringify(state);
  const gz = gzipSync(Buffer.from(json, "utf8"));
  const b64 = gz.toString("base64");
  return `${STATE_MARKER_START}${b64}${STATE_MARKER_END}`;
}

export function extractState(walkthroughBody: string | null | undefined): WalkthroughState | null {
  if (!walkthroughBody) return null;
  const start = walkthroughBody.indexOf(STATE_MARKER_START);
  if (start === -1) return null;
  const after = start + STATE_MARKER_START.length;
  const end = walkthroughBody.indexOf(STATE_MARKER_END, after);
  if (end === -1) return null;
  const b64 = walkthroughBody.slice(after, end).trim();
  try {
    const gz = Buffer.from(b64, "base64");
    const json = gunzipSync(gz).toString("utf8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      return parsed as WalkthroughState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the diff is "trivial" — only changes whitespace, imports,
 * comments, or otherwise carries no semantic weight. Used to populate the
 * "Files skipped from review due to trivial changes" list.
 */
export function isTrivialPatch(patch: string): boolean {
  if (!patch || patch.trim().length === 0) return true;
  const changedLines = patch
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
  if (changedLines.length === 0) return true;

  const TRIVIAL_RE = [
    /^[+-]\s*$/, // blank
    /^[+-]\s*\/\//, // line comment
    /^[+-]\s*#\s/, // hash comment
    /^[+-]\s*\/?\*/, // block comment
    /^[+-]\s*\*/, // continuation of block comment
    /^[+-]\s*import\s/, // ES/TS import
    /^[+-]\s*from\s+['"]/, // python from-import
    /^[+-]\s*export\s+\*\s+from\s/, // ES re-export
    /^[+-]\s*"[^"]+":\s*"[^"]+",?$/, // package.json simple version bump
  ];

  return changedLines.every((l) => TRIVIAL_RE.some((re) => re.test(l)));
}
