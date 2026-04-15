import { PRContext, ReviewComment, ReviewResult, WalkthroughResult, CommentType, CommentSeverity } from "../types.js";
import { logger } from "../logger.js";

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

const VALID_TYPES: CommentType[] = ["issue", "suggestion", "nitpick"];
const VALID_SEVERITIES: CommentSeverity[] = ["critical", "major", "minor", "trivial"];

function formatCommentBody(body: string, type?: CommentType, severity?: CommentSeverity): string {
  if (!type && !severity) return body;

  const typeEmoji: Record<CommentType, string> = {
    issue: "⚠️",
    suggestion: "🛠️",
    nitpick: "🧹",
  };

  const severityEmoji: Record<CommentSeverity, string> = {
    critical: "🔴",
    major: "🟠",
    minor: "🟡",
    trivial: "🔵",
  };

  const prefix = [
    type ? `${typeEmoji[type]} **${type}**` : "",
    severity ? `${severityEmoji[severity]} ${severity}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return prefix ? `${prefix}\n\n${body}` : body;
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

      return {
        path: c.path,
        line: c.line,
        side: "RIGHT" as const,
        body: formatCommentBody(c.body, type, severity),
        type,
        severity,
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

  return {
    summary: parsed.summary || "Walkthrough generated.",
    fileDescriptions: (parsed.fileDescriptions || []).map((fd: any) => ({
      filename: fd.filename || "",
      status: fd.status || "modified",
      changeDescription: fd.changeDescription || "",
    })),
    effortEstimate: typeof parsed.effortEstimate === "number"
      ? Math.min(5, Math.max(1, Math.round(parsed.effortEstimate)))
      : undefined,
    sequenceDiagram: parsed.sequenceDiagram || undefined,
    suggestedLabels: Array.isArray(parsed.suggestedLabels) ? parsed.suggestedLabels : undefined,
    suggestedReviewers: Array.isArray(parsed.suggestedReviewers) ? parsed.suggestedReviewers : undefined,
    poem: parsed.poem || undefined,
  };
}
