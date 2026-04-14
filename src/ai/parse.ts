import { PRContext, ReviewComment, ReviewResult } from "../types.js";
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
    if (line.startsWith("-")) continue; // removed line, don't advance right counter
    if (line.startsWith("+")) {
      lines.add(rightLine);
      rightLine++;
    } else {
      // context line
      lines.add(rightLine);
      rightLine++;
    }
  }
  return lines;
}

export function parseReviewResponse(raw: string, context: PRContext): ReviewResult {
  const log = logger.child({ step: "parse" });

  // Strip markdown fences if the model wrapped the JSON
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
      summary: raw.slice(0, 2000),
      comments: [],
      approval: "COMMENT",
    };
  }

  // Build a map of valid diff lines per file
  const diffLinesByFile = new Map<string, Set<number>>();
  for (const f of context.files) {
    diffLinesByFile.set(f.filename, getDiffLines(f.patch));
  }

  // Validate and clean comments
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
    .map((c: any) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      body: c.body,
    }));

  const approval = ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(parsed.approval)
    ? parsed.approval
    : "COMMENT";

  return {
    summary: parsed.summary || "Review complete.",
    comments,
    approval,
  };
}
