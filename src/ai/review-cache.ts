import { createHash } from "node:crypto";
import type { Config, PRContext, ReviewResult } from "../types.js";
import { readReviewCache, writeReviewCache } from "../storage/dao.js";
import { logger } from "../logger.js";

/**
 * Review result cache.
 *
 * The same diff gets reviewed more than once more often than it looks: a rebase
 * onto a moved base, a force-push that restores a tree already reviewed, a
 * revert-and-reapply, a `@bot full review` on an unchanged branch, a retry after
 * a transient provider failure. Cross-review dedup already stops those from
 * *posting* twice — it has never stopped them from *billing* twice, because the
 * model call happens before dedup ever sees a fingerprint. This closes that gap.
 *
 * Correctness rests entirely on the key, so the key is the whole design: see
 * {@link reviewCacheKey}. Everything else here is retention and a kill switch.
 */

/** How long a cached review stays usable. */
const TTL_DAYS = 14;

/** `DIFFSENTRY_REVIEW_CACHE=0` turns it off; anything else (including unset) leaves it on. */
export function reviewCacheEnabled(): boolean {
  return process.env.DIFFSENTRY_REVIEW_CACHE !== "0";
}

function cutoffIso(now = new Date()): string {
  return new Date(now.getTime() - TTL_DAYS * 86_400_000).toISOString();
}

/**
 * `provider:model` for the PRIMARY provider — the identity the key is stamped
 * with. A failover answer is never cached (see the write path), so a row always
 * means "this is what the primary said".
 */
export function primaryModelId(config: Config): string {
  const model =
    config.aiProvider === "anthropic"
      ? config.anthropicModel
      : config.aiProvider === "openai"
        ? config.openaiModel
        : config.localAiModel;
  return `${config.aiProvider}:${model}`;
}

/**
 * The exact prompt the model would receive, with each file's patch swapped for a
 * whitespace-normalized hash of itself.
 *
 * Hashing the prompt verbatim would be one line shorter and is the obvious move,
 * but it would never hit: a rebase rewrites every `@@` hunk header without
 * changing a line of code, and a rebase is the most common reason the same diff
 * is reviewed twice. The caller supplies each patch already paired with its
 * `patchHash` digest — the same normalizer cross-review dedup fingerprints with,
 * which strips hunk headers and collapses whitespace while preserving each
 * line's +/- direction and folding in the filename, so two different edits can't
 * share a hash. (The caller computes it so this module never has to import the
 * reviewer, which imports the AI layer.)
 *
 * Everything else in the prompt stays verbatim and therefore participates in the
 * key: the system prompt (so a profile change, or a future edit to the review
 * instructions this module never hears about, invalidates every row), the repo
 * config, the learnings, the title, the description, and the related-context
 * block. The model id is prepended because the same prompt answers differently
 * on a different model.
 *
 * Patches are substituted by literal string replacement, so passing both the raw
 * patch and the budget-truncated patch a large PR actually sends is harmless —
 * whichever one the builder put in the prompt is the one that matches.
 */
export function reviewCacheKey(opts: {
  model: string;
  system: string;
  user: string;
  patches: Array<{ text: string; digest: string }>;
}): string {
  let user = opts.user;
  const seen = new Set<string>();
  for (const { text, digest } of opts.patches) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    user = user.split(text).join(`<patch:${digest}>`);
  }
  return createHash("sha256").update(`${opts.model}\u0000${opts.system}\u0000${user}`).digest("hex");
}

/**
 * A previously cached result for this key, or null.
 *
 * `servedBy` is deliberately not restored: it records which provider answered
 * *this* pass, and a replay was answered by nobody. `parseFailed` results are
 * never written, so a hit is always a real review.
 */
export function readCachedReview(cacheKey: string): ReviewResult | null {
  if (!reviewCacheEnabled()) return null;
  const row = readReviewCache(cacheKey, cutoffIso());
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.resultJson) as ReviewResult;
    if (!parsed || !Array.isArray(parsed.comments)) return null;
    delete parsed.servedBy;
    return parsed;
  } catch (err) {
    logger.debug({ err }, "Discarding unreadable review-cache row");
    return null;
  }
}

/**
 * Store a result. A parse failure is never cached: it is the provider having a
 * bad day, not a property of the diff, and freezing one for a fortnight would
 * turn a transient blip into a silently unreviewed branch.
 */
export function writeCachedReview(opts: {
  cacheKey: string;
  model: string;
  context: PRContext;
  result: ReviewResult;
}): void {
  if (!reviewCacheEnabled()) return;
  if (opts.result.parseFailed) return;
  writeReviewCache({
    cacheKey: opts.cacheKey,
    owner: opts.context.owner,
    repo: opts.context.repo,
    number: opts.context.pullNumber,
    model: opts.model,
    resultJson: JSON.stringify(opts.result),
    maxAgeIso: cutoffIso(),
  });
}
