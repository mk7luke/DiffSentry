import { randomUUID } from "node:crypto";
import type {
  Confidence,
  PRContext,
  ReviewComment,
  ReviewResult,
  RepoConfig,
} from "./types.js";

export type ReviewBodyMeta = {
  profile: string;
  owner: string;
  repo: string;
  baseSha?: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  filesProcessed: string[];
  filesIgnoredByPathFilter?: Array<{ path: string; reason: string }>;
  filesAutoIgnored?: Array<{ path: string; reason: string }>;
  filesNoReviewableChanges?: string[];
  filesSkippedTrivial?: string[];
  filesSkippedSimilar?: string[];
  /** Files whose patch was truncated to fit the large-diff size budget (still reviewed, partially). */
  filesTruncatedForSize?: string[];
  /** Files dropped entirely from the model prompt to fit the large-diff size budget (NOT reviewed). */
  filesSkippedForSize?: string[];
  configUsed?: string;
  plan?: string;
  botName: string;
  /** When set, this is an incremental review and lastReviewedSha was the previous head. */
  incrementalFromSha?: string;
};

export const REVIEW_BODY_MARKER = "<!-- This is an auto-generated comment by DiffSentry for review status -->";

/**
 * Honest banner for the parse-failure path. When the AI's response can't be
 * parsed as JSON there are NO AI-generated inline comments — only built-in
 * safety/pattern findings ran. Without this, a parse failure renders as a
 * clean "0 actionable comments / no concerns surfaced" review, which is a
 * silent failure: the user believes the code was reviewed and approved when it
 * wasn't. This makes the gap explicit and promises a retry.
 */
function parseFailureBanner(botName: string): string {
  return [
    "> [!CAUTION]",
    "> **DiffSentry could not complete this review.** The AI returned a response that couldn't be parsed, so AI-generated inline comments are missing from this pass. Built-in safety and pattern checks still ran and are reflected below.",
    ">",
    "> This is usually transient — most often a reasoning model exhausting its token budget on hidden reasoning before emitting any output (server logs show `finishReason: \"length\"` with a high `reasoningTokens` count).",
    ">",
    `> DiffSentry will retry this review automatically; you can also re-run it now with \`@${botName} review\`.`,
  ].join("\n");
}

/**
 * Bucket logic: only critical/major bugs and security findings are
 * "actionable". Everything else (refactor suggestions, nitpicks,
 * documentation hints, minor issues) goes into the Nitpicks collapse.
 * Mirrors CodeRabbit's "Actionable comments posted" semantics.
 */
export function isNitpick(c: ReviewComment): boolean {
  if (c.type === "nitpick" || c.type === "suggestion" || c.type === "documentation") {
    return true;
  }
  if (c.severity === "trivial" || c.severity === "minor") return true;
  return false;
}

/**
 * The two flavours of `prLevel` finding, distinguished by whether a `path`
 * survived. Both carry line 0 and are excluded from inline posting.
 *
 * - FILE-level (`path` set): the model located the finding in a specific file
 *   but on a line we couldn't anchor to the diff (see the demotion path in
 *   ai/parse.ts). GitHub can host these as real, resolvable file-scoped review
 *   threads (`subject_type: "file"`), so they are posted as threads rather than
 *   rendered into the review body.
 * - BODY-level (`path` empty): no file to attach to at all — the diff versus the
 *   PR description, or a concern spanning the whole change. GitHub has nowhere
 *   to hang a thread, so these are the only findings that must live as prose in
 *   the review body.
 */
export function isFileLevelFinding(c: ReviewComment): boolean {
  return c.prLevel === true && !!c.path && c.line === 0;
}

export function isPrBodyFinding(c: ReviewComment): boolean {
  return c.prLevel === true && !c.path;
}

/** Confidence with the documented default applied (see ai/prompt.ts: an omitted
 *  confidence means the model was sure enough not to qualify the finding). */
export function confidenceOf(c: ReviewComment): Confidence {
  return c.confidence ?? "high";
}

/**
 * Whether a finding is actionable AND lands somewhere the reader can act on it.
 *
 * Inline and file-level findings become resolvable threads, so being actionable
 * is enough. Body-level findings are unresolvable prose in the review summary —
 * the one place noise cannot be dismissed — so they must additionally be
 * high-confidence to claim that space. A medium/low-confidence body finding
 * still renders, but in a collapsed block and without inflating the count.
 *
 * Single source of truth for both the "Actionable comments posted" count and the
 * REQUEST_CHANGES invariant, so the number in the header and the verdict can
 * never disagree about what counts.
 */
export function isVisiblyActionable(c: ReviewComment): boolean {
  if (isNitpick(c)) return false;
  if (isPrBodyFinding(c)) return confidenceOf(c) === "high";
  return true;
}

/**
 * A REQUEST_CHANGES verdict must be backed by at least one finding the reader
 * can actually see and act on. When every backing finding was dropped by
 * line-anchoring/verification, demoted into a collapsed low-confidence block, or
 * the model requested changes while describing the problem only in the summary,
 * return COMMENT so the verdict and the visible findings never contradict each
 * other. Pure and one-directional: only ever relaxes a block, never creates one.
 */
export function reconcileApproval(
  approval: ReviewResult["approval"],
  comments: ReviewComment[],
): ReviewResult["approval"] {
  if (approval === "REQUEST_CHANGES" && !comments.some(isVisiblyActionable)) {
    return "COMMENT";
  }
  return approval;
}

function fileHeading(path: string, count: number): string {
  return `<details>\n<summary>${path} (${count})</summary><blockquote>\n`;
}

function renderNitpickEntry(c: ReviewComment): string {
  const title = c.title?.trim() || c.body.split("\n")[0].slice(0, 120);
  const lines: string[] = [];
  lines.push(`\`Line ${c.line}\`: **${title.replace(/\*\*/g, "")}**`);
  if (c.body && c.body.trim()) {
    lines.push("");
    lines.push(c.body.trim());
  }
  if (c.suggestion && c.suggestion.trim()) {
    const lang = c.suggestionLanguage === "diff" ? "diff" : "suggestion";
    const cleaned = c.suggestion
      .replace(/^```(?:\w+)?\s*\n?/, "")
      .replace(/\n?\s*```$/, "");
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>♻️ Suggested fix</summary>");
    lines.push("");
    lines.push("```" + lang);
    lines.push(cleaned);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
  }
  if (c.aiAgentPrompt && c.aiAgentPrompt.trim()) {
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>🤖 Prompt for AI Agents</summary>");
    lines.push("");
    lines.push("```text");
    lines.push(
      c.aiAgentPrompt.startsWith("Verify each finding")
        ? c.aiAgentPrompt
        : `Verify each finding against the current code and only fix it if needed.\n\n${c.aiAgentPrompt}`,
    );
    lines.push("```");
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n");
}

/**
 * Body-level findings with nowhere to hang a thread — the diff contradicts the
 * PR description, a claimed change is missing, a concern spans the whole change.
 * Without this section they'd be invisible: the review would read as "changes
 * requested / 0 actionable comments" with the substance only hinted at in the
 * summary. Each comment's `body` is already the fully-formatted standalone block
 * (type/severity header, title, prose, agent prompt), so we render it directly.
 *
 * Deliberately narrow. This is the only DiffSentry output a reader cannot
 * resolve, reply to, or collapse — it reprints in full on every subsequent
 * review — so entry is gated on high confidence by isVisiblyActionable.
 * Everything else goes to renderUncertainPrLevelSection below.
 */
function renderPrLevelSection(prLevel: ReviewComment[]): string {
  if (prLevel.length === 0) return "";
  const blocks = prLevel.map((c) => c.body.trim()).join("\n\n---\n\n");
  return [
    `### 🔎 Issues not tied to a specific line (${prLevel.length})`,
    "",
    "<sub>These findings concern the change as a whole (for example, the diff versus the PR description) and can't be attached to a single changed line.</sub>",
    "",
    blocks,
  ].join("\n");
}

/**
 * Body-level findings the model itself flagged as medium/low confidence. They're
 * hypotheses that depend on intent the model can't see, so they're worth
 * surfacing but not worth the top of the review: collapsed, and excluded from
 * the actionable count. Same treatment the nitpick collapse gives uncertain
 * inline findings.
 */
function renderUncertainPrLevelSection(prLevel: ReviewComment[]): string {
  if (prLevel.length === 0) return "";
  const blocks = prLevel.map((c) => c.body.trim()).join("\n\n---\n\n");
  return [
    `<details>`,
    `<summary>🤔 Lower-confidence observations about the change as a whole (${prLevel.length})</summary><blockquote>`,
    "",
    "<sub>DiffSentry is unsure about these — they depend on intent it can't verify from the diff. Worth a glance, not a blocker.</sub>",
    "",
    blocks,
    "",
    `</blockquote></details>`,
  ].join("\n");
}

function renderNitpicksSection(nitpicks: ReviewComment[]): string {
  if (nitpicks.length === 0) return "";

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of nitpicks) {
    const arr = byFile.get(c.path) ?? [];
    arr.push(c);
    byFile.set(c.path, arr);
  }

  const fileBlocks: string[] = [];
  for (const [path, comments] of byFile) {
    const block: string[] = [];
    block.push(fileHeading(path, comments.length));
    for (const c of comments) {
      block.push(renderNitpickEntry(c));
      block.push("");
    }
    block.push("</blockquote></details>");
    fileBlocks.push(block.join("\n"));
  }

  return [
    `<details>`,
    `<summary>🧹 Nitpick comments (${nitpicks.length})</summary><blockquote>`,
    "",
    fileBlocks.join("\n"),
    "",
    `</blockquote></details>`,
  ].join("\n");
}

function renderBulkAiPrompt(comments: ReviewComment[]): string {
  const withPrompts = comments.filter((c) => c.aiAgentPrompt && c.aiAgentPrompt.trim());
  if (withPrompts.length === 0) return "";

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of withPrompts) {
    const arr = byFile.get(c.path) ?? [];
    arr.push(c);
    byFile.set(c.path, arr);
  }

  const sections: string[] = ["Verify each finding against the current code and only fix it if needed.", ""];
  for (const [path, items] of byFile) {
    sections.push(`In \`${path}\`:`);
    for (const c of items) {
      const oneLine = (c.aiAgentPrompt ?? "")
        .replace(/^Verify each finding[^\n]*\n*/i, "")
        .trim();
      sections.push(`- Line ${c.line}: ${oneLine}`);
    }
    sections.push("");
  }

  return [
    `<details>`,
    `<summary>🤖 Prompt for all review comments with AI agents</summary>`,
    "",
    "```text",
    sections.join("\n").trim(),
    "```",
    "",
    `</details>`,
  ].join("\n");
}

function renderAutofixSection(): string {
  const idCommit = randomUUID();
  const idNewPr = randomUUID();
  return [
    `<details>`,
    `<summary>🪄 Autofix (Beta)</summary>`,
    "",
    "Fix all unresolved DiffSentry comments on this PR:",
    "",
    `- [ ] <!-- {"checkboxId": "${idCommit}"} --> Push a commit to this branch (recommended)`,
    `- [ ] <!-- {"checkboxId": "${idNewPr}"} --> Create a new PR with the fixes`,
    "",
    `</details>`,
  ].join("\n");
}

function renderFileList(label: string, items: string[] | undefined, emoji: string): string {
  if (!items || items.length === 0) return "";
  const bullets = items.map((p) => `* \`${p}\``).join("\n");
  return [
    `<details>`,
    `<summary>${emoji} ${label} (${items.length})</summary>`,
    "",
    bullets,
    "",
    `</details>`,
  ].join("\n");
}

function renderFileListWithReason(
  label: string,
  items: Array<{ path: string; reason: string }> | undefined,
  emoji: string,
): string {
  if (!items || items.length === 0) return "";
  const bullets = items
    .map((it) => `* \`${it.path}\` is excluded by \`${it.reason}\``)
    .join("\n");
  return [
    `<details>`,
    `<summary>${emoji} ${label} (${items.length})</summary>`,
    "",
    bullets,
    "",
    `</details>`,
  ].join("\n");
}

function renderReviewInfo(meta: ReviewBodyMeta, runId: string): string {
  const config = [
    `**Configuration used**: ${meta.configUsed ?? "defaults"}`,
    `**Review profile**: ${meta.profile.toUpperCase()}`,
    meta.plan ? `**Plan**: ${meta.plan}` : "",
    `**Run ID**: \`${runId}\``,
  ]
    .filter(Boolean)
    .join("\n\n");

  const commitLink = (sha: string) =>
    `[\`${sha.slice(0, 7)}\`](https://github.com/${meta.owner}/${meta.repo}/commit/${sha})`;
  const commits = meta.incrementalFromSha
    ? `Reviewing files that changed from ${commitLink(meta.incrementalFromSha)} to ${commitLink(meta.headSha)}. Previously-reviewed commits are not re-reviewed.`
    : meta.baseSha
    ? `Reviewing files that changed from the base of the PR and between ${commitLink(meta.baseSha)} and ${commitLink(meta.headSha)}.`
    : `Reviewing files at ${commitLink(meta.headSha)} (base SHA unavailable).`;

  // Optional file-list blocks return "" when the list is empty — drop those
  // entries (only those entries) so we don't emit double blank lines. The
  // OTHER blank lines in this array are load-bearing: GitHub's markdown
  // parser only parses content inside <details> when it's preceded by a
  // blank line after <summary>. Without them, [text](url) renders literally.
  const sections = [
    `<details>`,
    `<summary>ℹ️ Review info</summary>`,
    "",
    `<details>`,
    `<summary>⚙️ Run configuration</summary>`,
    "",
    config,
    "",
    `</details>`,
    "",
    `<details>`,
    `<summary>📥 Commits</summary>`,
    "",
    commits,
    "",
    `</details>`,
    "",
    renderFileListWithReason("Files ignored due to path filters", meta.filesIgnoredByPathFilter, "⛔"),
    renderFileList("Files selected for processing", meta.filesProcessed, "📒"),
    renderFileList("Files with no reviewable changes", meta.filesNoReviewableChanges, "💤"),
    renderFileList("Files skipped from review due to trivial changes", meta.filesSkippedTrivial, "✅"),
    renderFileList(
      "Files skipped from review as they are similar to previous changes",
      meta.filesSkippedSimilar,
      "🚧",
    ),
    renderFileList(
      "Files with diffs truncated to fit the review size budget",
      meta.filesTruncatedForSize,
      "✂️",
    ),
    renderFileList(
      "Files skipped from review due to size (not sent to the model)",
      meta.filesSkippedForSize,
      "🪓",
    ),
    `</details>`,
  ];
  // Stitch with single newlines but interleave blank lines between non-empty
  // file-list blocks so each one keeps its own <summary>-then-blank pattern.
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s === "" && out[out.length - 1] === "") continue; // collapse double blanks
    out.push(s);
  }
  return out.join("\n");
}

export function formatReviewBody(
  result: ReviewResult,
  meta: ReviewBodyMeta,
): string {
  // Buckets, by where each finding ends up in the rendered PR.
  //
  //   inline    → resolvable line threads (posted by submitReview)
  //   fileLevel → resolvable file threads (posted by submitReview); NOT rendered
  //               here, or they'd say everything twice
  //   prBody    → prose in this body; the only unresolvable channel, so it's
  //               split by confidence: high gets its own section, the rest
  //               collapses
  //
  // The "posted" count spans everything visibly actionable across all three, so
  // a blocking review whose only finding is unanchored still reads honestly
  // instead of "Actionable comments posted: 0".
  const fileLevel = result.comments.filter(isFileLevelFinding);
  const prBody = result.comments.filter(isPrBodyFinding);
  const inline = result.comments.filter((c) => !c.prLevel);
  const nitpicks = inline.filter(isNitpick);
  const prBodyProminent = prBody.filter(isVisiblyActionable);
  const prBodyUncertain = prBody.filter((c) => !isVisiblyActionable(c));
  const actionableCount = [...inline, ...fileLevel, ...prBody].filter(isVisiblyActionable).length;
  const runId = randomUUID();

  const sections: string[] = [];

  // Parse failure: lead with the honest banner so the review never reads as a
  // clean pass. The flag is threaded straight from ReviewResult (set in
  // parse.ts when JSON extraction fails) — see parseFailureBanner.
  if (result.parseFailed) {
    sections.push(parseFailureBanner(meta.botName));
  }

  sections.push(`**Actionable comments posted: ${actionableCount}**`);

  // Show the AI/synthesized summary — but suppress it on the parse-failure path
  // when there are no findings at all, because the synthesized text there reads
  // as "no actionable findings", which contradicts the banner above. When real
  // (safety/pattern) findings exist, the synthesized summary accurately counts
  // them, so it's still worth showing under the banner.
  const suppressSummary = result.parseFailed && result.comments.length === 0;
  if (!suppressSummary && result.summary && result.summary.trim()) {
    sections.push(result.summary.trim());
  }

  const prLevelBlock = renderPrLevelSection(prBodyProminent);
  if (prLevelBlock) sections.push(prLevelBlock);

  const nitpicksBlock = renderNitpicksSection(nitpicks);
  if (nitpicksBlock) sections.push(nitpicksBlock);

  const uncertainBlock = renderUncertainPrLevelSection(prBodyUncertain);
  if (uncertainBlock) sections.push(uncertainBlock);

  // Only inline comments feed the bulk agent prompt — its entries are keyed by
  // `path`/`line`, which PR-level findings don't have (their agent prompt is
  // already shown inline in the PR-level section above).
  const bulkPrompt = renderBulkAiPrompt(inline);
  if (bulkPrompt) sections.push(bulkPrompt);

  if (result.comments.length > 0) {
    sections.push(renderAutofixSection());
  }

  sections.push("---");
  sections.push(renderReviewInfo(meta, runId));
  sections.push(REVIEW_BODY_MARKER);

  return sections.join("\n\n");
}
