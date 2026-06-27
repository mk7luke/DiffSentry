import type { AIProvider, PRContext, ReviewComment } from "../types.js";
import { logger } from "../logger.js";
import { withAiTimeout, DEFAULT_AI_REQUEST_TIMEOUT_MS } from "./timeout.js";
import { getDiffLineInfo } from "./parse.js";

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
  /** Findings excluded from the AI pass because their file had no usable patch
   *  (or its diff didn't fit the prompt budget). Always kept — fail-open. */
  skipped: number;
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

/*
 * Prompt-budget envelope for the single batched verification call. The caps are
 * sized together against the output cap (`maxTokens: 1024` on the ai.complete
 * call below) so the pass stays cheap and never truncates its own answer:
 *
 *   - MAX_TOTAL_PATCH_CHARS = 32000 (~8k input tokens at ~4 chars/token) bounds
 *     the diff payload — the dominant input cost. With MAX_PATCH_CHARS_PER_FILE
 *     = 8000 (~2k tokens) that's roughly 4 full files of diff per pass; more
 *     files just truncate/omit (findings on the cut parts stay fail-open).
 *   - CLAIM_BODY_MAX = 400 chars/finding (~100 tokens) keeps the findings list
 *     small even for dozens of findings.
 *   - Output is tiny: each verdict is `{"index","supported","citedLines":[…]}`
 *     ≈ 15-25 tokens, so 1024 output tokens comfortably covers ~40+ findings —
 *     well past what one PR realistically produces.
 *
 * So a median request is well under ~12k input tokens. When tuning one cap,
 * keep the input total proportional to the ~1024-token output ceiling: a much
 * larger diff budget risks more findings than the output can verdict on.
 */
const MAX_PATCH_CHARS_PER_FILE = 8000;
const MAX_TOTAL_PATCH_CHARS = 32000;

/**
 * Budget-aware selection of which referenced files' diffs to embed in the
 * verifier prompt. Only files with a usable patch that fit the per-file/total
 * caps are included; the rest are dropped from the prompt. Returns the rendered
 * diff blocks and the set of files actually included, so the caller can keep
 * findings whose diff we couldn't show fail-open rather than asking the verifier
 * to judge them blind. Logs when anything is truncated/omitted.
 */
export function selectVerifierDiffs(
  context: Pick<PRContext, "files">,
  paths: Set<string>,
): { blocks: string[]; includedFiles: Set<string>; shownLinesByFile: Map<string, Set<number>> } {
  // Only files referenced by a finding are worth sending — the verifier judges
  // those findings and nothing else, so unreferenced patches are pure noise.
  const relevant = context.files.filter((f) => paths.has(f.filename));

  const includedFiles = new Set<string>();
  // Right-side line numbers actually visible in the embedded slice, per file.
  // For a truncated patch this is only the prefix; the caller uses it to keep
  // findings whose supporting line was cut away fail-open instead of letting
  // the verifier drop them blind.
  const shownLinesByFile = new Map<string, Set<number>>();
  let totalChars = 0;
  let truncatedFiles = 0;
  let omittedFiles = 0;
  const blocks: string[] = [];
  for (const f of relevant) {
    const patch = f.patch ?? "";
    if (patch.trim().length === 0) continue; // no usable diff to show
    const remaining = MAX_TOTAL_PATCH_CHARS - totalChars;
    if (remaining <= 0) {
      omittedFiles++;
      continue;
    }
    const cap = Math.min(MAX_PATCH_CHARS_PER_FILE, remaining);
    let shown = patch;
    let truncated = false;
    if (patch.length > cap) {
      // Cut at a line boundary so the embedded diff stays parseable and the
      // visible-line set is exact (no half-line at the tail). If there's no
      // newline within the budget (a single line longer than the cap), we can't
      // truncate safely — omit the file so its findings stay fail-open rather
      // than verify them against a mid-line diff fragment.
      const nl = patch.lastIndexOf("\n", cap);
      if (nl <= 0) {
        omittedFiles++;
        continue;
      }
      shown = patch.slice(0, nl);
      truncated = true;
    }
    const shownLines = getDiffLineInfo(shown).valid;
    if (shownLines.size === 0) {
      // Truncation left no usable right-side line (e.g. only a hunk header fit).
      // Embedding a stub helps nobody; treat the file as omitted so its findings
      // stay fail-open rather than being judged against an empty diff.
      omittedFiles++;
      continue;
    }
    if (truncated) truncatedFiles++;
    totalChars += shown.length;
    includedFiles.add(f.filename);
    shownLinesByFile.set(f.filename, shownLines);
    const note = truncated ? "\n… (patch truncated for verification)" : "";
    blocks.push(`### ${f.filename}\n\`\`\`diff\n${shown}${note}\n\`\`\``);
  }

  if (truncatedFiles > 0 || omittedFiles > 0) {
    logger.child({ step: "verify-findings" }).warn(
      { relevantFiles: relevant.length, truncatedFiles, omittedFiles, totalChars },
      "Verifier prompt diff bounded — some patches truncated/omitted to stay within budget",
    );
  }

  return { blocks, includedFiles, shownLinesByFile };
}

/** Assemble the verifier prompt from already-selected diff blocks and the exact
 *  findings being judged. Pure: the caller decides which findings/diffs go in,
 *  so the findings list and the verdict index space stay in lockstep. */
export function buildVerificationPrompt(
  diffBlocks: string[],
  comments: ReviewComment[],
): { system: string; user: string } {
  const diffs = diffBlocks.join("\n\n");

  const user = `## Diff under review

${diffs}

## Findings to verify

${findingsBlock(comments)}

For each finding above, decide whether the diff substantiates it and cite the supporting line number(s). Respond with the JSON object described in the system prompt.`;

  return { system: VERIFY_SYSTEM, user };
}

/** Parse the verifier's JSON, tolerating fences / surrounding prose. Returns
 *  null when a COMPLETE, usable verdict set can't be recovered (caller fails
 *  open). */
function parseVerdicts(raw: string, count: number): Verdict[] | null {
  let cleaned = raw.trim();
  // Pull the payload out of a ```/```json fence even when the model wrapped it
  // in prose ("Here is the JSON:\n```json …```"). Matching the fence anywhere
  // (not just at the start) avoids the brace-slice fallback tripping over a
  // trailing fence or stray `}` in the surrounding text. No fence → use as-is.
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenced) {
    cleaned = fenced[1].trim();
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

  // A duplicate index means the model broke the "exactly one verdict per
  // finding" contract — and a contradictory duplicate (true AND false for the
  // same finding) is genuine ambiguity where picking either is arbitrary. Treat
  // any duplicate as a malformed response: bail to null so the caller fails open
  // and keeps everything, consistent with the completeness check below.
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
      if (seen.has(v.index)) return null;
      seen.add(v.index);
      verdicts.push({ index: v.index, supported: v.supported });
    }
  }

  // The verifier must return exactly one usable verdict per finding. Anything
  // short of that — an empty/`[{}]` set, missing indices, a partial/truncated
  // response — is an incomplete verification we can't trust to delete findings
  // from. Treat it as unparseable so the caller fails open AND flags it, rather
  // than acting on an unreliable subset (or silently reading it as a clean
  // "everything supported" pass). A genuinely truncated payload is usually
  // already caught above as invalid JSON; this guards the valid-but-incomplete
  // case where the model simply omitted verdicts.
  if (count > 0 && verdicts.length !== count) return null;

  return verdicts;
}

/** Rejection used when the review's abort signal fires during the verifier
 *  call — distinct from AiTimeoutError/provider errors so the caller can treat
 *  cancellation as a clean no-op (keep all findings) rather than a failure. */
class VerificationAbortedError extends Error {
  constructor() {
    super("verification aborted");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "VerificationAbortedError";
  }
}

/** Resolve/reject with `p`, but reject early with VerificationAbortedError the
 *  moment `signal` aborts. The abort listener is removed once `p` settles so it
 *  never leaks, and `p`'s eventual rejection stays handled (no unhandled
 *  rejection) even after the race resolves on abort. */
function withAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new VerificationAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new VerificationAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
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
  /** The review's abort signal. When it fires (e.g. the PR was closed), the
   *  best-effort verifier round-trip is abandoned and the ORIGINAL findings are
   *  returned immediately — an aborted review never blocks on this extra call. */
  signal?: AbortSignal;
}): Promise<{ comments: ReviewComment[]; stats: VerificationStats }> {
  const { ai, context, comments, timeoutMs = DEFAULT_AI_REQUEST_TIMEOUT_MS, signal } = params;
  const log = logger.child({ step: "verify-findings" });
  const before = comments.length;

  // Cancellation is a clean no-op: keep every finding, drop nothing, not flagged
  // unparseable. Used both for an already-aborted review and for an abort that
  // lands mid-call.
  const keepAll = (): { comments: ReviewComment[]; stats: VerificationStats } => ({
    comments,
    stats: { before, after: before, dropped: 0, skipped: 0, unparseable: false },
  });

  if (before === 0) {
    return { comments, stats: { before, after: 0, dropped: 0, skipped: 0, unparseable: false } };
  }

  if (signal?.aborted) {
    log.info("Verification skipped — review already aborted; keeping all findings");
    return keepAll();
  }

  // Partition findings by whether their file even has a usable patch. A finding
  // whose file is missing or has an empty diff can't be substantiated through
  // no fault of its own — sending it to the verifier would only invite a blind
  // "unsupported" drop. Those are never sent and always kept (fail-open); we
  // run the AI on the verifiable subset only, tracking original indices so we
  // can map verdicts back.
  const fileByPath = new Map(context.files.map((f) => [f.filename, f] as const));
  const hasUsablePatch = (path: string): boolean => {
    const f = fileByPath.get(path);
    return !!f && !!f.patch && f.patch.trim().length > 0;
  };

  const verifiableIdx: number[] = [];
  let skipped = 0;
  for (let i = 0; i < comments.length; i++) {
    if (hasUsablePatch(comments[i].path)) verifiableIdx.push(i);
    else skipped++; // no usable patch — kept fail-open, never sent
  }

  // Decide which referenced files' diffs actually fit the prompt budget, then
  // narrow the verifiable set to findings whose supporting diff is genuinely
  // present in what we sent. A finding is dropped from the verifiable set when
  // its file was budget-omitted OR its line was truncated out of the embedded
  // slice — in both cases the verifier can't see the lines that back it, so it's
  // counted as skipped and kept fail-open, never sent. This keeps the findings
  // list handed to the model and the verdict index space aligned, and stops a
  // valid finding from being dropped just because its hunk was cut for budget.
  const verifiablePaths = new Set(verifiableIdx.map((i) => comments[i].path));
  const { blocks, includedFiles, shownLinesByFile } = selectVerifierDiffs(context, verifiablePaths);
  const includedIdx = verifiableIdx.filter((i) => {
    const c = comments[i];
    if (!includedFiles.has(c.path)) return false;
    const shownLines = shownLinesByFile.get(c.path);
    // shownLines is the exact set of visible right-side lines (the whole patch
    // when untruncated, only the prefix when truncated). Verify only findings
    // whose line we actually showed.
    return !!shownLines && shownLines.has(c.line);
  });
  skipped += verifiableIdx.length - includedIdx.length; // budget-omitted or truncated-away findings

  if (includedIdx.length === 0) {
    log.info({ skipped }, "Verification skipped — no findings have a diff that fits the prompt; keeping all");
    return { comments, stats: { before, after: before, dropped: 0, skipped, unparseable: false } };
  }
  if (skipped > 0) {
    log.info({ skipped, verified: includedIdx.length }, "Some findings skipped from verification (no usable/in-budget diff), kept fail-open");
  }

  // `included` is the COMPACTED subset actually sent to the verifier: the
  // prompt enumerates these as Finding 0..included.length-1, so the model's
  // verdict indices live in that compacted space. `includedIdx[v.index]` maps a
  // compacted index back to the original `comments` index (which may be
  // non-contiguous once budget-omitted findings have been removed).
  const included = includedIdx.map((i) => comments[i]);
  const { system, user } = buildVerificationPrompt(blocks, included);
  // Bound the call explicitly here too, independent of any provider-level
  // deadline, so this best-effort pass is self-isolating. `complete` doesn't
  // take a signal; withAiTimeout still rejects on time even when the inner
  // call ignores the signal.
  let raw: string;
  try {
    raw = await withAbort(
      withAiTimeout(
        { provider: "verify", operation: "verify-findings", timeoutMs },
        // 1024 output tokens fits ~40+ small verdict objects — see the budget
        // envelope on MAX_TOTAL_PATCH_CHARS; the input caps are sized against it.
        () => ai.complete(system, user, { json: true, maxTokens: 1024 }),
      ),
      signal,
    );
  } catch (err) {
    // Cancellation: don't wait on the round-trip for a review that's going away.
    // Other errors (AiTimeoutError, provider failures) propagate to the caller's
    // catch, which fails open the same way.
    if (err instanceof VerificationAbortedError) {
      log.info("Verification aborted mid-call — keeping all findings");
      return keepAll();
    }
    throw err;
  }

  const verdicts = parseVerdicts(raw, included.length);
  if (verdicts === null) {
    log.warn("Verification response unparseable; keeping all findings (fail-open)");
    return { comments, stats: { before, after: before, dropped: 0, skipped, unparseable: true } };
  }

  // Drop ONLY findings the verifier explicitly marked unsupported, mapping the
  // included-subset index back to the original comment index.
  const unsupported = new Set<number>();
  for (const v of verdicts) {
    if (v.supported === false) unsupported.add(includedIdx[v.index]);
  }

  const kept = comments.filter((_, i) => !unsupported.has(i));
  const dropped = before - kept.length;
  if (dropped > 0) {
    log.info({ before, after: kept.length, dropped, skipped }, "Verification pass dropped unsubstantiated findings");
  }

  return { comments: kept, stats: { before, after: kept.length, dropped, skipped, unparseable: false } };
}
