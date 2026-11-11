import { logger } from "./logger.js";
import { bulkTriageFindings, getFindingIdsByFingerprint, recordEvent } from "./storage/dao.js";

/**
 * Reaction feedback: the cheapest signal a maintainer can give a reviewer.
 *
 * Replying to a finding already teaches a learning (see `synthesizeLearning`),
 * but it costs a sentence and a round trip through the model. A 👎 costs two
 * clicks, and until now DiffSentry threw it away. This module reads the
 * reactions on its own inline findings and turns them into the triage state the
 * command center and `getSuppressedFingerprints` already understand, so the
 * feedback loop closes without anyone typing.
 *
 * GitHub has no `reaction` webhook event for Apps, so there is nothing to
 * subscribe to — the reactions are polled once per review pass, which is also
 * exactly when the answer is needed.
 */

/** Reactions on one of our review threads, as read from the head comment. */
export interface ThreadFeedback {
  /** Dedup fingerprint stamped in the comment body. */
  fingerprint: string;
  path: string | null;
  /** Logins that reacted 👎. Our own bot is filtered out before this. */
  down: string[];
  /** Logins that reacted 👍. */
  up: string[];
}

export interface ReactionFeedbackResult {
  /** Fingerprints a human thumbed down — this pass must not re-raise them. */
  dismissed: Set<string>;
  /** Fingerprints a human thumbed up. */
  affirmed: Set<string>;
  /** Finding rows whose triage state actually changed. */
  rowsChanged: number;
}

const EMPTY: ReactionFeedbackResult = { dismissed: new Set(), affirmed: new Set(), rowsChanged: 0 };

/**
 * A bot's own login is spelled two ways depending on which GitHub API answered:
 * REST says `diffsentry[bot]`, GraphQL's `Bot.login` says `diffsentry`. Reaction
 * data comes back over GraphQL, so matching only the REST spelling would let our
 * own reactions (anything that ever reacts as the App) read as human feedback.
 */
function isSelf(login: string, botName: string): boolean {
  const l = login.toLowerCase();
  const name = botName.toLowerCase();
  return l === name || l === `${name}[bot]`;
}

/**
 * Turn thread reactions into finding triage.
 *
 * A thread carrying both 👍 and 👎 is left untouched: two maintainers disagree,
 * and silently taking one side would retire a finding class on a coin flip.
 * Everything else is unambiguous — 👎 dismisses the fingerprint (accepted = 0,
 * which is what `getSuppressedFingerprints` reads), 👍 accepts it.
 *
 * Writes are per-fingerprint, not per-finding, so a 👎 retires the whole class
 * across every PR it has ever fired on. That is the point: a false positive is
 * a property of the rule, not of the pull request that happened to trip it.
 */
export function applyReactionFeedback(opts: {
  owner: string;
  repo: string;
  number: number;
  botName: string;
  threads: ThreadFeedback[];
}): ReactionFeedbackResult {
  if (opts.threads.length === 0) return EMPTY;

  const dismissed = new Set<string>();
  const affirmed = new Set<string>();
  // Logins per fingerprint, so the triage row records who actually reacted
  // rather than an anonymous "reaction".
  const byFingerprint = new Map<string, { accepted: boolean; who: string[] }>();

  for (const t of opts.threads) {
    if (!t.fingerprint) continue;
    const down = t.down.filter((l) => !isSelf(l, opts.botName));
    const up = t.up.filter((l) => !isSelf(l, opts.botName));
    if (down.length > 0 && up.length > 0) {
      logger.debug({ fp: t.fingerprint, path: t.path }, "Reaction feedback split 👍/👎; leaving triage untouched");
      continue;
    }
    if (down.length === 0 && up.length === 0) continue;

    const accepted = up.length > 0;
    (accepted ? affirmed : dismissed).add(t.fingerprint);
    // Earlier threads win on a repeat fingerprint only if they agree; a later
    // disagreement is the split case above, handled per-thread.
    const prior = byFingerprint.get(t.fingerprint);
    if (prior && prior.accepted !== accepted) {
      byFingerprint.delete(t.fingerprint);
      dismissed.delete(t.fingerprint);
      affirmed.delete(t.fingerprint);
      continue;
    }
    byFingerprint.set(t.fingerprint, {
      accepted,
      who: [...new Set([...(prior?.who ?? []), ...(accepted ? up : down)])],
    });
  }

  let rowsChanged = 0;
  for (const [fingerprint, { accepted, who }] of byFingerprint) {
    const ids = getFindingIdsByFingerprint(fingerprint);
    if (ids.length === 0) continue;
    const changed = bulkTriageFindings({
      ids,
      accepted,
      triagedBy: who[0] ?? null,
      triageNote: `${accepted ? "👍" : "👎"} on ${opts.owner}/${opts.repo}#${opts.number} by ${who.join(", ")}`,
    });
    rowsChanged += changed;
    if (changed > 0) {
      recordEvent({
        owner: opts.owner,
        repo: opts.repo,
        number: opts.number,
        kind: "feedback.reaction",
        payload: { fingerprint, accepted, by: who, findings: changed },
      });
    }
  }

  if (dismissed.size > 0 || affirmed.size > 0) {
    logger.info(
      { dismissed: dismissed.size, affirmed: affirmed.size, rowsChanged, owner: opts.owner, repo: opts.repo, pr: opts.number },
      "Applied reaction feedback to finding triage",
    );
  }
  return { dismissed, affirmed, rowsChanged };
}
