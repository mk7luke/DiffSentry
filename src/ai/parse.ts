import { createHash } from "node:crypto";
import { PRContext, ReviewComment, ReviewResult, WalkthroughResult, CommentType, CommentSeverity, Confidence } from "../types.js";
import { logger } from "../logger.js";

const VALID_CONFIDENCE: Confidence[] = ["high", "medium", "low"];

const CONFIDENCE_TAG: Record<Confidence, string> = {
  high: "",
  medium: "🤔 _Medium confidence_ — verify against intent before acting.",
  low: "🤔 _Low confidence_ — flagging as a hypothesis; may not apply.",
};

/**
 * Per-file diff line geometry on the RIGHT side (new file):
 *   - `valid`: every right-side line number GitHub will accept an inline
 *     comment on (added + surrounding context lines).
 *   - `added`: just the `+` (changed) line numbers, ascending. Preferred
 *     anchors when remapping a finding whose line drifted off the diff.
 */
interface DiffLineInfo {
  valid: Set<number>;
  added: number[];
}

export function getDiffLineInfo(patch: string): DiffLineInfo {
  const valid = new Set<number>();
  const added: number[] = [];
  let rightLine = 0;

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      rightLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      valid.add(rightLine);
      added.push(rightLine); // ascending by construction
      rightLine++;
    } else {
      valid.add(rightLine);
      rightLine++;
    }
  }
  return { valid, added };
}

/**
 * Models routinely report a finding against a line a few rows off from the
 * one it actually means (a header line, a blank, the line above/below). Rather
 * than silently discard those — losing a real finding — we snap them to the
 * nearest valid diff line, preferring a changed (`+`) line. We only remap
 * within {@link MAX_REMAP_DISTANCE}: a finding pointing dozens of lines away
 * from anything in the diff is most likely a hallucinated location, and
 * anchoring it somewhere arbitrary would just relocate the hallucination, so
 * those are dropped instead. Returns the anchor line, or null if none is close
 * enough.
 */
const MAX_REMAP_DISTANCE = 25;

function nearestAnchor(line: number, info: DiffLineInfo): number | null {
  // Prefer the changed lines; fall back to any GitHub-commentable line.
  const candidates =
    info.added.length > 0 ? info.added : [...info.valid].sort((a, b) => a - b);

  let best: number | null = null;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = Math.abs(cand - line);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }

  if (best === null || bestDist > MAX_REMAP_DISTANCE) return null;
  return best;
}

const VALID_TYPES: CommentType[] = [
  "issue",
  "suggestion",
  "nitpick",
  "documentation",
  "security",
];
const VALID_SEVERITIES: CommentSeverity[] = ["critical", "major", "minor", "trivial"];

const TYPE_LABEL: Record<CommentType, string> = {
  issue: "Potential issue",
  suggestion: "Refactor suggestion",
  nitpick: "Nitpick",
  documentation: "Documentation",
  security: "Security",
};

const TYPE_ICON: Record<CommentType, string> = {
  issue: "⚠️",
  suggestion: "🛠️",
  nitpick: "🧹",
  documentation: "📝",
  security: "🔒",
};

const SEVERITY_LABEL: Record<CommentSeverity, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
  trivial: "Trivial",
};

const SEVERITY_ICON: Record<CommentSeverity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🟢",
};

export function normalizeForFingerprint(s: string): string {
  // Collapse case, punctuation, and runs of whitespace so that trivial
  // re-wording (re-indentation, capitalization, stray punctuation) of the same
  // finding still dedupes. We keep the FULL normalized title — truncating to a
  // token prefix used to collapse genuinely distinct findings that happened to
  // share an opening phrase into one fingerprint, silently dropping the rest.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
}

export function fingerprintFor(path: string, line: number, title: string): string {
  // Hash off the full normalized title (lowercased, alphanum, whitespace-
  // collapsed) so re-wording the same finding doesn't break dedup while
  // distinct findings stay distinct. The path is kept raw so true cross-file
  // findings still distinguish.
  return createHash("sha1")
    .update(`${path}:${line}:${normalizeForFingerprint(title)}`)
    .digest("hex")
    .slice(0, 12);
}

/** Words too common to carry meaning in a finding title — including the negations
 *  and auxiliaries that flip freely between re-runs ("does not" ⇄ "doesn't"). */
const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "not", "but", "its", "it", "is", "are", "was", "were", "be", "been",
  "does", "doesnt", "dont", "did", "didnt", "do", "has", "have", "had", "can", "cant",
  "will", "wont", "this", "that", "these", "those", "with", "from", "into", "than", "then",
  "when", "while", "which", "who", "whose", "what", "any", "all", "only", "still", "also",
  "there", "their", "they", "you", "your", "our", "via", "per", "out", "off", "own",
]);

/** Content tokens of a finding title, for similarity matching. */
function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeForFingerprint(title)
      .split(" ")
      .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t)),
  );
}

/**
 * Jaccard similarity (0..1) over the content words of two finding titles.
 *
 * Exists because fingerprintFor can't dedup PR-level findings across reviews.
 * An inline finding is pinned by `path:line`, so its fingerprint is stable even
 * when the model re-words the title. A PR-level finding has line 0 and often no
 * path, leaving the title as effectively the whole key — and PR-level titles are
 * free prose regenerated by the model on every run. One re-wording ("tk02 does
 * not change the default" → "tk02 never sets the default") mints a fresh
 * fingerprint, dedup misses, and the finding reprints in every review body.
 * Comparing meaning-bearing tokens instead of hashing exact strings survives
 * that.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Tuned against the failure it exists to stop: the same drift finding re-worded
 * between runs. Distinct PR-level findings on one PR name different files and
 * symbols (the drift prompt demands specifics), so they overlap well below this;
 * re-wordings of one finding keep their nouns and land well above it. Set
 * deliberately short of aggressive — a missed repeat is a duplicate paragraph in
 * a collapsed block, while an over-eager match silently swallows a real finding.
 */
const PR_LEVEL_REPEAT_THRESHOLD = 0.6;

/** Serialized prior-finding key: path (may be empty) + title. */
export function prLevelRepeatKey(path: string, title: string): string {
  return `${path}\t${title}`;
}

/**
 * Whether a PR-level finding restates one already posted on a previous review.
 * Only compares findings scoped to the same file (or both unscoped), so a real
 * finding is never swallowed by a same-sounding one about different code.
 */
export function isRepeatPrLevelFinding(
  candidate: { path: string; title?: string },
  priorKeys: string[],
): boolean {
  const title = candidate.title?.trim();
  if (!title) return false;
  return priorKeys.some((key) => {
    const tab = key.indexOf("\t");
    if (tab === -1) return false;
    if (key.slice(0, tab) !== candidate.path) return false;
    return titleSimilarity(key.slice(tab + 1), title) >= PR_LEVEL_REPEAT_THRESHOLD;
  });
}

function stripFences(input: string): string {
  let s = input.trim();
  s = s.replace(/^```(?:\w+)?\s*\n?/, "");
  s = s.replace(/\n?\s*```$/, "");
  return s;
}

function renderSuggestionBlock(suggestion: string, language: "diff" | "suggestion"): string {
  const cleaned = stripFences(suggestion);
  return `<details>\n<summary>🔧 Proposed fix</summary>\n\n\`\`\`${language}\n${cleaned}\n\`\`\`\n\n</details>`;
}

function renderAiAgentPromptBlock(prompt: string): string {
  const trimmed = prompt.trim();
  const withPreamble = trimmed.startsWith("Verify each finding")
    ? trimmed
    : `Verify each finding against the current code and only fix it if needed.\n\n${trimmed}`;
  return `<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\n\`\`\`text\n${withPreamble}\n\`\`\`\n\n</details>`;
}

export function renderInlineCommentBody(comment: {
  title?: string;
  body: string;
  type?: CommentType;
  severity?: CommentSeverity;
  suggestion?: string;
  suggestionLanguage?: "diff" | "suggestion";
  aiAgentPrompt?: string;
  fingerprint?: string;
  confidence?: Confidence;
}): string {
  return formatCommentBody(comment);
}

function formatCommentBody(comment: {
  title?: string;
  body: string;
  type?: CommentType;
  severity?: CommentSeverity;
  suggestion?: string;
  suggestionLanguage?: "diff" | "suggestion";
  aiAgentPrompt?: string;
  fingerprint?: string;
  confidence?: Confidence;
}): string {
  const parts: string[] = [];

  if (comment.type || comment.severity) {
    const typePart = comment.type
      ? `_${TYPE_ICON[comment.type]} ${TYPE_LABEL[comment.type]}_`
      : "";
    const sevPart = comment.severity
      ? `_${SEVERITY_ICON[comment.severity]} ${SEVERITY_LABEL[comment.severity]}_`
      : "";
    parts.push([typePart, sevPart].filter(Boolean).join(" | "));
  }

  if (comment.title) {
    const cleanTitle = comment.title.trim().replace(/\*\*/g, "");
    parts.push(`**${cleanTitle}**`);
  }

  if (comment.confidence && comment.confidence !== "high") {
    const tag = CONFIDENCE_TAG[comment.confidence];
    if (tag) parts.push(`> ${tag}`);
  }

  parts.push(comment.body.trim());

  if (comment.suggestion && comment.suggestion.trim()) {
    const lang = comment.suggestionLanguage === "diff" ? "diff" : "suggestion";
    parts.push(renderSuggestionBlock(comment.suggestion, lang));
  }

  if (comment.aiAgentPrompt && comment.aiAgentPrompt.trim()) {
    parts.push(renderAiAgentPromptBlock(comment.aiAgentPrompt));
  }

  if (comment.fingerprint) {
    parts.push(`<!-- diffsentry-fingerprint:${comment.fingerprint} -->`);
  }

  parts.push("<!-- This is an auto-generated reply by DiffSentry -->");

  return parts.join("\n\n");
}

/**
 * Try every reasonable angle to coerce the model's response into JSON:
 *   1. Strip ``` / ```json fences and parse directly.
 *   2. Slice from the first `{` to the last `}` (handles models that wrap
 *      JSON in prose like "Here's the review: { ... }").
 *   3. Same as (2) but for arrays `[...]`.
 * Returns the parsed object on success, null on failure.
 */
function extractJsonObject(raw: string): any | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "").trim();
  }
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to embedded-object extraction
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Build an informative one- or two-sentence summary from the review state
 * itself, used whenever the AI didn't return a usable `summary` field (or
 * its response wasn't structured at all). Replaces the old "Review complete
 * (no structured response from AI)." text, which conveyed neither what was
 * reviewed nor what was found.
 *
 * Safe to call after `comments` has been augmented with built-in safety /
 * pattern findings — the counts reflect whatever's in `comments` at call
 * time, so the reviewer can re-synthesize once all sources are merged.
 */
export function synthesizeReviewSummary(
  result: Pick<ReviewResult, "comments" | "approval">,
  context: Pick<PRContext, "files">,
): string {
  const fileCount = context.files.length;
  const filePart = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  const total = result.comments.length;

  if (total === 0) {
    return result.approval === "APPROVE"
      ? `Reviewed ${filePart}. No concerns surfaced — the change looks safe to merge.`
      : `Reviewed ${filePart}. No actionable findings — see the walkthrough above for an overview of what changed.`;
  }

  const sev: Record<CommentSeverity, number> = { critical: 0, major: 0, minor: 0, trivial: 0 };
  const ty: Record<CommentType, number> = {
    issue: 0,
    suggestion: 0,
    nitpick: 0,
    documentation: 0,
    security: 0,
  };
  for (const c of result.comments) {
    if (c.severity) sev[c.severity]++;
    if (c.type) ty[c.type]++;
  }

  const sevParts: string[] = [];
  if (sev.critical) sevParts.push(`${sev.critical} critical`);
  if (sev.major) sevParts.push(`${sev.major} major`);
  if (sev.minor) sevParts.push(`${sev.minor} minor`);
  if (sev.trivial) sevParts.push(`${sev.trivial} trivial`);
  const sevSegment = sevParts.length > 0 ? ` (${sevParts.join(", ")})` : "";

  const tyParts: string[] = [];
  if (ty.security) tyParts.push(`${ty.security} security`);
  if (ty.issue) tyParts.push(`${ty.issue} issue${ty.issue === 1 ? "" : "s"}`);
  if (ty.suggestion) tyParts.push(`${ty.suggestion} suggestion${ty.suggestion === 1 ? "" : "s"}`);
  if (ty.nitpick) tyParts.push(`${ty.nitpick} nitpick${ty.nitpick === 1 ? "" : "s"}`);
  if (ty.documentation) tyParts.push(`${ty.documentation} doc note${ty.documentation === 1 ? "" : "s"}`);
  const breakdown = tyParts.length > 0 ? ` Breakdown: ${tyParts.join(", ")}.` : "";

  const headline = `Reviewed ${filePart} and surfaced ${total} finding${total === 1 ? "" : "s"}${sevSegment}.`;
  return `${headline}${breakdown} See inline comments for details.`;
}

/** Shape of one comment as it arrives from the model: untyped JSON, so every
 *  field is optional and validated at runtime in parseReviewResponse. */
export interface RawComment {
  path?: string;
  line?: number;
  body?: string;
  title?: string;
  type?: string;
  severity?: string;
  suggestion?: string;
  suggestionLanguage?: string;
  aiAgentPrompt?: string;
  confidence?: string;
}

/**
 * Build a validated ReviewComment from an untrusted raw model comment plus the
 * already-resolved anchor. Shared by the inline path (a real diff line), the
 * un-anchorable-demotion path, and the PR-level path (line 0, prLevel: true) so
 * all three produce identical body/fingerprint formatting. Assumes `c.body` is
 * present (the caller validated it).
 */
export function buildReviewComment(
  c: RawComment,
  anchor: { path: string; line: number; prLevel: boolean },
): ReviewComment {
  const type = VALID_TYPES.includes(c.type as CommentType) ? (c.type as CommentType) : undefined;
  const severity = VALID_SEVERITIES.includes(c.severity as CommentSeverity) ? (c.severity as CommentSeverity) : undefined;
  const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : undefined;
  const suggestion = typeof c.suggestion === "string" && c.suggestion.trim() ? c.suggestion : undefined;
  const suggestionLanguage: "diff" | "suggestion" =
    c.suggestionLanguage === "diff" ? "diff" : "suggestion";
  const aiAgentPrompt = typeof c.aiAgentPrompt === "string" && c.aiAgentPrompt.trim()
    ? c.aiAgentPrompt
    : undefined;
  const confidence = VALID_CONFIDENCE.includes(c.confidence as Confidence) ? (c.confidence as Confidence) : "high";
  const fingerprint = fingerprintFor(anchor.path, anchor.line, title || c.body!.slice(0, 80));

  return {
    path: anchor.path,
    line: anchor.line,
    side: "RIGHT" as const,
    body: formatCommentBody({
      title,
      body: c.body!,
      type,
      severity,
      suggestion,
      suggestionLanguage,
      aiAgentPrompt,
      fingerprint,
      confidence,
    }),
    type,
    severity,
    title,
    suggestion,
    suggestionLanguage,
    aiAgentPrompt,
    fingerprint,
    confidence,
    ...(anchor.prLevel ? { prLevel: true } : {}),
  };
}

export function parseReviewResponse(raw: string, context: PRContext): ReviewResult {
  const log = logger.child({ step: "parse" });

  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    // We couldn't recover any JSON. Don't pretend we have an AI summary —
    // tell the user honestly what happened, and synthesize a description
    // of what was reviewed so they have *some* useful signal. The reviewer
    // will re-synthesize once built-in safety/pattern findings are merged.
    const rawSnippet = raw.trim().slice(0, 500);
    log.warn({ rawSnippet }, "Failed to extract JSON from AI response");
    return {
      summary: synthesizeReviewSummary({ comments: [], approval: "COMMENT" }, context),
      comments: [],
      approval: "COMMENT",
      summaryIsFallback: true,
      parseFailed: true,
    };
  }

  const diffInfoByFile = new Map<string, DiffLineInfo>();
  for (const f of context.files) {
    diffInfoByFile.set(f.filename, getDiffLineInfo(f.patch));
  }

  // Track how many findings we couldn't anchor (dropped) vs. snapped to a
  // nearby valid line (remapped) vs. demoted to PR-level so the loss/rescue is
  // visible in logs instead of silent. See nearestAnchor for the remap rationale.
  let droppedCount = 0;
  let remappedCount = 0;
  let demotedCount = 0;
  const comments: ReviewComment[] = [];

  // Model output is untrusted JSON, so we model an incoming comment as a loose
  // record of optional primitives and validate every field at runtime below.
  // Non-array `comments` (the model returned an object, a string, …) degrades
  // to an empty list rather than throwing mid-parse.
  const rawComments: RawComment[] = Array.isArray(parsed.comments) ? parsed.comments : [];

  for (const c of rawComments) {
    if (!c.path || !c.body || typeof c.line !== "number" || c.line < 1) {
      droppedCount++;
      continue;
    }
    const info = diffInfoByFile.get(c.path);
    if (!info) {
      log.warn({ path: c.path }, "Comment references unknown file, dropping");
      droppedCount++;
      continue;
    }

    const severity = VALID_SEVERITIES.includes(c.severity as CommentSeverity) ? (c.severity as CommentSeverity) : undefined;

    // Anchor the finding to a real diff line: keep it as-is when it already
    // lands on one, otherwise snap to the nearest changed line. When no line is
    // close enough we can't post it inline — but rather than losing a real
    // blocking finding (a critical/major issue the model located imprecisely,
    // which is exactly how diff-vs-description discrepancies present), we DEMOTE
    // it to a PR-level finding so its substance still reaches the reviewer.
    // Minor/trivial un-anchorable findings are still dropped: not worth the
    // noise once they've slipped their line.
    let line = c.line;
    if (!info.valid.has(line)) {
      const anchor = nearestAnchor(line, info);
      if (anchor === null) {
        if (severity === "critical" || severity === "major") {
          comments.push(buildReviewComment(c, { path: c.path, line: 0, prLevel: true }));
          demotedCount++;
          log.info(
            { path: c.path, line, severity },
            "Un-anchorable blocking finding demoted to PR-level (kept, not posted inline)",
          );
        } else {
          log.warn(
            { path: c.path, line },
            "Comment references line not in diff with no nearby anchor, dropping",
          );
          droppedCount++;
        }
        continue;
      }
      log.info({ path: c.path, from: line, to: anchor }, "Remapped finding to nearest valid diff line");
      line = anchor;
      remappedCount++;
    }

    comments.push(buildReviewComment(c, { path: c.path, line, prLevel: false }));
  }

  // PR-level findings: the model's dedicated channel for issues not tied to a
  // single changed line (diff contradicts the PR description, a claimed change
  // is missing, cross-cutting concerns). No anchoring and — per the schema in
  // ai/prompt.ts, which gives these entries no "path"/"line" — always built with
  // path: "" so their title-based fingerprint stays stable across reviews.
  // Non-array degrades to none.
  const rawPrLevel: RawComment[] = Array.isArray(parsed.prLevelComments) ? parsed.prLevelComments : [];
  let prLevelKept = 0;
  for (const c of rawPrLevel) {
    if (!c.body || !(typeof c.title === "string" && c.title.trim())) continue;
    comments.push(buildReviewComment(c, { path: "", line: 0, prLevel: true }));
    prLevelKept++;
  }

  if (droppedCount > 0 || remappedCount > 0 || demotedCount > 0 || prLevelKept > 0) {
    log.info(
      { dropped: droppedCount, remapped: remappedCount, demoted: demotedCount, prLevel: prLevelKept, kept: comments.length },
      "Finding line validation complete",
    );
  }

  const approval = ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.approval)
    ? parsed.approval
    : "COMMENT";

  const aiSummary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const summaryIsFallback = aiSummary.length === 0;
  const summary = summaryIsFallback
    ? synthesizeReviewSummary({ comments, approval }, context)
    : aiSummary;

  return {
    summary,
    comments,
    approval,
    summaryIsFallback,
  };
}

/**
 * Mermaid treats `;` as a statement terminator inside sequence diagrams,
 * so message labels like `Backend->>AI: generate TL;DR after completion`
 * blow up the parser at the semicolon. We rewrite the message portion of
 * each statement (everything after the first unquoted `:`) to escape `;`
 * with the HTML entity `&#59;`, which Mermaid renders as a literal `;`.
 * Lines that aren't messages (participant decls, notes, activations, etc.)
 * are left untouched.
 */
function sanitizeMermaidSequenceDiagram(diagram: string): string {
  // Sequence-diagram arrow tokens (longest first so `-->>` wins over `->`).
  const ARROWS = ["-->>", "->>", "-->", "->", "--x", "-x", "--)", "-)"];
  const lines = diagram.split("\n");

  return lines
    .map((line) => {
      const arrow = ARROWS.find((a) => line.includes(a));
      if (!arrow) return line;
      const colonIdx = line.indexOf(":", line.indexOf(arrow) + arrow.length);
      if (colonIdx === -1) return line;
      const head = line.slice(0, colonIdx + 1);
      const tail = line.slice(colonIdx + 1).replace(/;/g, "&#59;");
      return head + tail;
    })
    .join("\n");
}

export function parseWalkthroughResponse(raw: string): WalkthroughResult {
  const log = logger.child({ step: "parse-walkthrough" });

  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    log.warn("Failed to parse walkthrough response as JSON");
    return {
      summary: raw.slice(0, 2000),
      fileDescriptions: [],
    };
  }

  const sequenceDiagrams: string[] | undefined = (() => {
    if (Array.isArray(parsed.sequenceDiagrams)) {
      return parsed.sequenceDiagrams
        .filter((s: any) => typeof s === "string" && s.trim().length > 0)
        .map((s: string) => sanitizeMermaidSequenceDiagram(s));
    }
    if (typeof parsed.sequenceDiagram === "string" && parsed.sequenceDiagram.trim().length > 0) {
      return [sanitizeMermaidSequenceDiagram(parsed.sequenceDiagram)];
    }
    return undefined;
  })();

  const cohorts = Array.isArray(parsed.cohorts)
    ? parsed.cohorts
        .filter((c: any) => c && typeof c.label === "string" && Array.isArray(c.files))
        .map((c: any) => ({
          label: c.label,
          files: c.files.filter((f: any) => typeof f === "string"),
          summary: typeof c.summary === "string" ? c.summary : "",
        }))
    : undefined;

  return {
    summary: parsed.summary || "Walkthrough generated.",
    fileDescriptions: (parsed.fileDescriptions || []).map((fd: any) => ({
      filename: fd.filename || "",
      status: fd.status || "modified",
      changeDescription: fd.changeDescription || "",
    })),
    cohorts,
    effortEstimate: typeof parsed.effortEstimate === "number"
      ? Math.min(5, Math.max(1, Math.round(parsed.effortEstimate)))
      : undefined,
    effortMinutes: typeof parsed.effortMinutes === "number"
      ? Math.max(1, Math.round(parsed.effortMinutes))
      : undefined,
    sequenceDiagrams,
    sequenceDiagram: sequenceDiagrams?.[0],
    suggestedLabels: Array.isArray(parsed.suggestedLabels) ? parsed.suggestedLabels : undefined,
    suggestedReviewers: Array.isArray(parsed.suggestedReviewers) ? parsed.suggestedReviewers : undefined,
    poem: parsed.poem || undefined,
  };
}
