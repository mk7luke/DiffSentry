// ─── Large-diff budgeting (large-diff guard) ───────────────────
//
// Bounds the size of the diff content sent to the model. Two budgets:
//   • per-file  — a single file's patch is intelligently truncated past a char
//     cap (hunk headers + a head/tail of each hunk are kept, so the model still
//     sees where the change is and a representative slice of it);
//   • per-review — the COMBINED budget for the diff plus the code-graph related-
//     context section. When the whole review would exceed it, higher-risk files
//     (auth/, payment/, migrations/, …) are kept first and lower-risk / larger
//     files are dropped, with the omissions reported back to the caller.
//
// This pass affects ONLY the model prompt. Deterministic scanners (safety,
// pattern, static analysis) and persistence always operate on the full diff —
// the caller keeps `context.files` intact and consults the result here when
// building the prompt and the human-facing review body.

import type {
  BudgetedFile,
  DiffBudgetConfig,
  DiffBudgetResult,
  FileChange,
} from "../types.js";
import { isHighRiskFile } from "../insights.js";

const DEFAULTS = {
  enabled: true,
  perFileChars: 24_000,
  perReviewChars: 180_000,
  keepHeadLines: 40,
  keepTailLines: 20,
};

export interface ResolvedDiffBudget {
  enabled: boolean;
  perFileChars: number;
  perReviewChars: number;
  keepHeadLines: number;
  keepTailLines: number;
}

/** Merge a `.diffsentry.yaml` `reviews.diff_budget` block over the defaults.
 *  Non-numeric / negative values fall back to the default (fail-open). */
export function resolveDiffBudget(cfg?: DiffBudgetConfig): ResolvedDiffBudget {
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
  return {
    enabled: cfg?.enabled !== false,
    perFileChars: num(cfg?.per_file_chars, DEFAULTS.perFileChars),
    perReviewChars: num(cfg?.per_review_chars, DEFAULTS.perReviewChars),
    keepHeadLines: num(cfg?.keep_head_lines, DEFAULTS.keepHeadLines),
    keepTailLines: num(cfg?.keep_tail_lines, DEFAULTS.keepTailLines),
  };
}

/**
 * Truncate one file's unified-diff patch to fit `perFileChars`, intelligently:
 * keep each hunk's `@@` header and the first `keepHeadLines` + last
 * `keepTailLines` of its body, marking the gap. If that still overflows (many
 * hunks), drop whole hunks from the end. A final hard slice guarantees the
 * result never exceeds the budget even for a single pathological hunk.
 *
 * Returns the original patch untouched when it already fits. Invariant: the
 * returned text is always `<= perFileChars` (applyDiffBudget relies on this to
 * size the per-review budget).
 */
export function truncatePatch(
  patch: string,
  opts: { perFileChars: number; keepHeadLines: number; keepTailLines: number },
): { text: string; truncated: boolean } {
  const { perFileChars, keepHeadLines, keepTailLines } = opts;
  if (patch.length <= perFileChars) return { text: patch, truncated: false };

  // Split into a preamble (anything before the first hunk header) and hunks.
  const preamble: string[] = [];
  const hunks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      cur = [line];
      hunks.push(cur);
    } else if (cur) {
      cur.push(line);
    } else {
      preamble.push(line);
    }
  }

  const trimHunk = (hunk: string[]): string[] => {
    const header = hunk[0];
    const body = hunk.slice(1);
    if (body.length <= keepHeadLines + keepTailLines) return hunk;
    const head = body.slice(0, keepHeadLines);
    const tail = keepTailLines > 0 ? body.slice(body.length - keepTailLines) : [];
    const omitted = body.length - head.length - tail.length;
    return [
      header,
      ...head,
      `… ${omitted} line(s) omitted from this hunk to fit the per-file size budget …`,
      ...tail,
    ];
  };

  const kept = hunks.map(trimHunk);
  const render = (hs: string[][]): string => [...preamble, ...hs.flat()].join("\n");
  const markerFor = (n: number): string =>
    `\n… ${n} later hunk(s) omitted entirely to fit the per-file size budget …`;

  // Still over budget after per-hunk trimming? Drop whole hunks from the end
  // (keep at least the first, most-context hunk). Reserve room for the trailing
  // marker so the final hard-slice below can't shear it off.
  let droppedHunks = 0;
  while (kept.length > 1 && render(kept).length + markerFor(droppedHunks + 1).length > perFileChars) {
    kept.pop();
    droppedHunks++;
  }

  let text = render(kept);
  if (droppedHunks > 0) {
    text += markerFor(droppedHunks);
  }

  // Final safety: a single giant hunk (or preamble) can still overflow. Reserve
  // room for the marker BEFORE slicing so the result never exceeds perFileChars —
  // applyDiffBudget relies on `text.length <= perFileChars` to size the per-review
  // budget. For a pathologically tiny budget that can't even hold the marker,
  // truncate the marker itself rather than overshoot.
  if (text.length > perFileChars) {
    const marker = "\n… patch hard-truncated at the per-file size budget …";
    text =
      perFileChars <= marker.length
        ? marker.slice(0, perFileChars)
        : text.slice(0, perFileChars - marker.length) + marker;
  }

  return { text, truncated: true };
}

/**
 * Apply the per-file and per-review budgets to a PR's changed files.
 *
 * `relatedContextChars` is the size of the code-graph related-context section the
 * caller will also send; it's subtracted from `per_review_chars` so the diff and
 * that section together stay within the combined budget (the model window). The
 * effective diff budget never drops below `per_file_chars`, so at least the
 * highest-priority file is always sent.
 *
 * Files are processed in their original order in the result, but inclusion is
 * decided high-risk-first (then smallest-first to fit more) so a size-capped
 * review spends its budget on the files that matter most.
 */
export function applyDiffBudget(
  files: Pick<FileChange, "filename" | "patch">[],
  cfg: DiffBudgetConfig | undefined,
  opts: { relatedContextChars?: number } = {},
): DiffBudgetResult {
  const r = resolveDiffBudget(cfg);

  const mkResult = (budgeted: BudgetedFile[], effective: number): DiffBudgetResult => {
    const byFile: Record<string, BudgetedFile> = {};
    for (const b of budgeted) byFile[b.filename] = b;
    return {
      enabled: r.enabled,
      files: budgeted,
      byFile,
      filesTruncated: budgeted.filter((b) => b.truncated).map((b) => b.filename),
      filesOmitted: budgeted.filter((b) => b.omitted).map((b) => b.filename),
      totalOriginalChars: budgeted.reduce((s, b) => s + b.originalChars, 0),
      totalSentChars: budgeted.reduce((s, b) => s + b.sentChars, 0),
      effectivePerReviewChars: effective,
      perFileChars: r.perFileChars,
    };
  };

  // Disabled ⇒ pass everything through untouched.
  if (!r.enabled) {
    const passthrough = files.map<BudgetedFile>((f) => ({
      filename: f.filename,
      patch: f.patch,
      truncated: false,
      omitted: false,
      originalChars: f.patch.length,
      sentChars: f.patch.length,
    }));
    return mkResult(passthrough, r.perReviewChars);
  }

  const effectivePerReview = Math.max(
    r.perFileChars,
    r.perReviewChars - Math.max(0, opts.relatedContextChars ?? 0),
  );

  // Per-file truncation first: every candidate patch now fits perFileChars.
  type Candidate = {
    index: number;
    filename: string;
    originalChars: number;
    patch: string;
    truncated: boolean;
    highRisk: boolean;
  };
  const candidates: Candidate[] = files.map((f, index) => {
    const { text, truncated } = truncatePatch(f.patch, {
      perFileChars: r.perFileChars,
      keepHeadLines: r.keepHeadLines,
      keepTailLines: r.keepTailLines,
    });
    return {
      index,
      filename: f.filename,
      originalChars: f.patch.length,
      patch: text,
      truncated,
      highRisk: isHighRiskFile(f.filename),
    };
  });

  // Inclusion order: high-risk first, then smallest candidate first (fit more),
  // then original index for stability.
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.highRisk) - Number(a.highRisk) ||
      a.patch.length - b.patch.length ||
      a.index - b.index,
  );

  const included = new Set<number>();
  let used = 0;
  for (const c of ranked) {
    // Always include at least the top-ranked file, even if it alone is large
    // (already truncated to perFileChars) — never send an empty diff.
    if (included.size === 0 || used + c.patch.length <= effectivePerReview) {
      included.add(c.index);
      used += c.patch.length;
    }
  }

  const budgeted = candidates.map<BudgetedFile>((c) => {
    if (!included.has(c.index)) {
      return {
        filename: c.filename,
        patch: "",
        truncated: false,
        omitted: true,
        originalChars: c.originalChars,
        sentChars: 0,
      };
    }
    return {
      filename: c.filename,
      patch: c.patch,
      truncated: c.truncated,
      omitted: false,
      originalChars: c.originalChars,
      sentChars: c.patch.length,
    };
  });

  return mkResult(budgeted, effectivePerReview);
}
