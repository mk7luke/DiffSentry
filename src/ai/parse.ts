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
 * Parse a unified diff patch and return the set of line numbers visible
 * on the RIGHT side (new file). These are the only lines GitHub allows
 * inline review comments on.
 */
function getDiffLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let rightLine = 0;

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      rightLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      lines.add(rightLine);
      rightLine++;
    } else {
      lines.add(rightLine);
      rightLine++;
    }
  }
  return lines;
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

function normalizeForFingerprint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
}

function fingerprintFor(path: string, line: number, title: string): string {
  // Hash off the normalized title (lowercased, alphanum, first 12 tokens) so
  // re-wording the same finding doesn't break dedup. The path is kept raw
  // so true cross-file findings still distinguish.
  return createHash("sha1")
    .update(`${path}:${line}:${normalizeForFingerprint(title)}`)
    .digest("hex")
    .slice(0, 12);
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

export function parseReviewResponse(raw: string, context: PRContext): ReviewResult {
  const log = logger.child({ step: "parse" });

  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    log.warn({ raw: raw.slice(0, 500) }, "Failed to parse AI response as JSON, using as summary");
    return {
      summary: raw.slice(0, 2000) || "Review complete (no structured response from AI).",
      comments: [],
      approval: "COMMENT",
    };
  }

  const diffLinesByFile = new Map<string, Set<number>>();
  for (const f of context.files) {
    diffLinesByFile.set(f.filename, getDiffLines(f.patch));
  }

  const comments: ReviewComment[] = (parsed.comments || [])
    .filter((c: any) => {
      if (!c.path || !c.line || !c.body) return false;
      const validLines = diffLinesByFile.get(c.path);
      if (!validLines) {
        log.warn({ path: c.path }, "Comment references unknown file, skipping");
        return false;
      }
      if (typeof c.line !== "number" || c.line < 1) return false;
      if (!validLines.has(c.line)) {
        log.warn({ path: c.path, line: c.line }, "Comment references line not in diff, skipping");
        return false;
      }
      return true;
    })
    .map((c: any) => {
      const type = VALID_TYPES.includes(c.type) ? c.type as CommentType : undefined;
      const severity = VALID_SEVERITIES.includes(c.severity) ? c.severity as CommentSeverity : undefined;
      const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : undefined;
      const suggestion = typeof c.suggestion === "string" && c.suggestion.trim() ? c.suggestion : undefined;
      const suggestionLanguage: "diff" | "suggestion" =
        c.suggestionLanguage === "diff" ? "diff" : "suggestion";
      const aiAgentPrompt = typeof c.aiAgentPrompt === "string" && c.aiAgentPrompt.trim()
        ? c.aiAgentPrompt
        : undefined;
      const confidence = VALID_CONFIDENCE.includes(c.confidence) ? (c.confidence as Confidence) : "high";
      const fingerprint = fingerprintFor(c.path, c.line, title || c.body.slice(0, 80));

      return {
        path: c.path,
        line: c.line,
        side: "RIGHT" as const,
        body: formatCommentBody({
          title,
          body: c.body,
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
      };
    });

  const approval = ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.approval)
    ? parsed.approval
    : "COMMENT";

  return {
    summary: parsed.summary || "Review complete.",
    comments,
    approval,
  };
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
      return parsed.sequenceDiagrams.filter((s: any) => typeof s === "string" && s.trim().length > 0);
    }
    if (typeof parsed.sequenceDiagram === "string" && parsed.sequenceDiagram.trim().length > 0) {
      return [parsed.sequenceDiagram];
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
