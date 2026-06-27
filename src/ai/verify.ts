import type { AIProvider, PRContext, ReviewComment } from "../types.js";
import { logger } from "../logger.js";
import { withAiTimeout, DEFAULT_AI_REQUEST_TIMEOUT_MS } from "./timeout.js";

/**
 * Second-pass finding verification.
 *
 * The first review pass occasionally hallucinates: a finding that reads
 * plausibly but isn't actually supported by anything in the diff. This pass
 * hands the model its OWN findings back alongside the diff and asks it to cite
 * the exact changed line(s) that substantiate each one — and to drop any it
 * can't. It is deliberately cheap: a single batched call covering every
 * finding, skipped entirely when the first pass produced none.
 *
 * It FAILS OPEN. If the verifier errors, times out, or returns something we
 * can't parse, we keep every original finding rather than risk discarding real
 * ones — the goal is to remove hallucinations, never to silently swallow the
 * whole review when the second call has a bad day.
 */

export interface VerificationStats {
  before: number;
  after: number;
  dropped: number;
  /** Verifier output couldn't be parsed — we kept all findings (fail-open). */
  unparseable: boolean;
}

interface Verdict {
  index: number;
  supported: boolean;
}

const VERIFY_SYSTEM = `You are a strict verification pass for an automated code reviewer.

You are given the diff of a pull request and a numbered list of findings that a previous pass produced about that diff. Your ONLY job is to decide, for each finding, whether the changed code in the diff actually substantiates it — and to cite the exact line number(s) that prove it.

A finding is "supported" ONLY when you can point to specific line(s) in the diff (right side / "+" or context lines shown) that demonstrate the problem it describes. If the finding depends on code you cannot see, misreads the diff, or describes something that isn't actually present in the changes, it is NOT supported.

Respond with ONLY valid JSON, no prose, no markdown fences:
{
  "verdicts": [
    { "index": 0, "supported": true, "citedLines": [42, 43] },
    { "index": 1, "supported": false, "citedLines": [] }
  ]
}

Rules:
- Include exactly one verdict object per finding, using the finding's index.
- "supported": true only if the cited lines genuinely back the finding; otherwise false.
- "citedLines": the diff line number(s) that substantiate the finding (empty when unsupported).
- Be conservative about dropping: mark "supported": false only when you are confident the diff does not back the finding. When genuinely unsure, keep it (true).
- Do not invent new findings. Judge only the ones given.`;

/** Max characters of finding body text handed to the verifier per finding.
 *  Enough to convey the actual claim; bounded so a long-winded finding can't
 *  blow up the batched prompt's token budget. */
const CLAIM_BODY_MAX = 400;

/** Strip the rendered body's markdown/HTML scaffolding (fingerprint + marker
 *  comments, <details>/<summary> tags) down to plain claim prose, collapse
 *  whitespace, and truncate. */
function normalizeClaimBody(body: string): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, " ") // fingerprint + auto-generated markers
    .replace(/<\/?[^>]+>/g, " ") // <details>, <summary>, etc.
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > CLAIM_BODY_MAX ? cleaned.slice(0, CLAIM_BODY_MAX) + "…" : cleaned;
}

function findingsBlock(comments: ReviewComment[]): string {
  return comments
    .map((c, i) => {
      const meta = [c.type, c.severity].filter(Boolean).join("/");
      const head = `Finding ${i}: ${c.path}:${c.line}${meta ? ` (${meta})` : ""}`;
      const title = c.title ? `\n  title: ${c.title}` : "";
      // Give the verifier the actual claim text — a terse title alone often
      // isn't enough to judge whether the diff substantiates the finding. The
      // body is normalized (scaffolding stripped) and truncated to keep the
      // single batched prompt bounded.
      const claim = normalizeClaimBody(c.body);
      const claimLine = claim ? `\n  claim: ${claim}` : "";
      return `${head}${title}${claimLine}`;
    })
    .join("\n");
}

/** Per-file and total caps on the diff text embedded in the verifier prompt.
 *  The verifier only needs the diffs for files that actually have findings, and
 *  even those are bounded so a single huge PR can't blow the prompt's token
 *  budget (which would itself cause the pass to fail and fall open). */
const MAX_PATCH_CHARS_PER_FILE = 8000;
const MAX_TOTAL_PATCH_CHARS = 32000;

export function buildVerificationPrompt(
  context: Pick<PRContext, "files">,
  comments: ReviewComment[],
): { system: string; user: string } {
  // Only files referenced by a finding are worth sending — the verifier judges
  // those findings and nothing else, so unreferenced patches are pure noise.
  const referenced = new Set(comments.map((c) => c.path));
  const relevant = context.files.filter((f) => referenced.has(f.filename));

  let totalChars = 0;
  let truncatedFiles = 0;
  let omittedFiles = 0;
  const blocks: string[] = [];
  for (const f of relevant) {
    const remaining = MAX_TOTAL_PATCH_CHARS - totalChars;
    if (remaining <= 0) {
      omittedFiles++;
      continue;
    }
    const cap = Math.min(MAX_PATCH_CHARS_PER_FILE, remaining);
    const patch = f.patch ?? "";
    const truncated = patch.length > cap;
    const shown = truncated ? patch.slice(0, cap) : patch;
    if (truncated) truncatedFiles++;
    totalChars += shown.length;
    const note = truncated ? "\n… (patch truncated for verification)" : "";
    blocks.push(`### ${f.filename}\n\`\`\`diff\n${shown}${note}\n\`\`\``);
  }

  if (truncatedFiles > 0 || omittedFiles > 0) {
    logger.child({ step: "verify-findings" }).warn(
      { relevantFiles: relevant.length, truncatedFiles, omittedFiles, totalChars },
      "Verifier prompt diff bounded — some patches truncated/omitted to stay within budget",
    );
  }

  const diffs = blocks.join("\n\n");

  const user = `## Diff under review

${diffs}

## Findings to verify

${findingsBlock(comments)}

For each finding above, decide whether the diff substantiates it and cite the supporting line number(s). Respond with the JSON object described in the system prompt.`;

  return { system: VERIFY_SYSTEM, user };
}

/** Parse the verifier's JSON, tolerating fences / surrounding prose. Returns
 *  null when no usable verdict array can be recovered (caller fails open). */
function parseVerdicts(raw: string, count: number): Verdict[] | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "").trim();
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        parsed = JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  const arr = parsed?.verdicts;
  if (!Array.isArray(arr)) return null;

  // Deterministic dedup: the first verdict for a given index wins, later
  // duplicates are ignored. A duplicated index (especially with a conflicting
  // `supported` value) would otherwise make the drop decision order-dependent
  // — and since any `false` triggers a drop, a stray duplicate could discard a
  // finding the verifier mostly backed. First-wins keeps it deterministic
  // without voiding the whole (otherwise usable) verdict set.
  const verdicts: Verdict[] = [];
  const seen = new Set<number>();
  for (const v of arr) {
    if (
      v &&
      typeof v.index === "number" &&
      Number.isInteger(v.index) &&
      v.index >= 0 &&
      v.index < count &&
      typeof v.supported === "boolean"
    ) {
      if (seen.has(v.index)) continue;
      seen.add(v.index);
      verdicts.push({ index: v.index, supported: v.supported });
    }
  }
  return verdicts;
}

export async function verifyFindings(params: {
  ai: Pick<AIProvider, "complete">;
  context: Pick<PRContext, "files">;
  comments: ReviewComment[];
  /** Deadline for the single verifier call. Defaults to the standard AI
   *  request timeout. A timeout rejects (AiTimeoutError), which the caller's
   *  catch turns into fail-open — the best-effort second pass can never block
   *  the whole review longer than this. */
  timeoutMs?: number;
}): Promise<{ comments: ReviewComment[]; stats: VerificationStats }> {
  const { ai, context, comments, timeoutMs = DEFAULT_AI_REQUEST_TIMEOUT_MS } = params;
  const log = logger.child({ step: "verify-findings" });
  const before = comments.length;

  if (before === 0) {
    return { comments, stats: { before, after: 0, dropped: 0, unparseable: false } };
  }

  const { system, user } = buildVerificationPrompt(context, comments);
  // Bound the call explicitly here too, independent of any provider-level
  // deadline, so this best-effort pass is self-isolating. `complete` doesn't
  // take a signal; withAiTimeout still rejects on time even when the inner
  // call ignores the signal.
  const raw = await withAiTimeout(
    { provider: "verify", operation: "verify-findings", timeoutMs },
    () => ai.complete(system, user, { json: true, maxTokens: 1024 }),
  );

  const verdicts = parseVerdicts(raw, before);
  if (verdicts === null) {
    log.warn("Verification response unparseable; keeping all findings (fail-open)");
    return { comments, stats: { before, after: before, dropped: 0, unparseable: true } };
  }

  // Drop ONLY findings the verifier explicitly marked unsupported. A finding
  // with no verdict (model omitted it) is kept — fail-open at the per-finding
  // level too.
  const unsupported = new Set<number>();
  for (const v of verdicts) {
    if (v.supported === false) unsupported.add(v.index);
  }

  const kept = comments.filter((_, i) => !unsupported.has(i));
  const dropped = before - kept.length;
  if (dropped > 0) {
    log.info({ before, after: kept.length, dropped }, "Verification pass dropped unsubstantiated findings");
  }

  return { comments: kept, stats: { before, after: kept.length, dropped, unparseable: false } };
}
