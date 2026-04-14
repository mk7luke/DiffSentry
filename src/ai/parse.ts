import { PRContext, ReviewComment, ReviewResult } from "../types.js";
import { logger } from "../logger.js";

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

  // Validate and clean comments
  const validFiles = new Set(context.files.map((f) => f.filename));
  const comments: ReviewComment[] = (parsed.comments || [])
    .filter((c: any) => {
      if (!c.path || !c.line || !c.body) return false;
      if (!validFiles.has(c.path)) {
        log.warn({ path: c.path }, "Comment references unknown file, skipping");
        return false;
      }
      if (typeof c.line !== "number" || c.line < 1) return false;
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
