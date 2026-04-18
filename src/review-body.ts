import { randomUUID } from "node:crypto";
import type {
  PRContext,
  ReviewComment,
  ReviewResult,
  RepoConfig,
} from "./types.js";

export type ReviewBodyMeta = {
  profile: string;
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
  configUsed?: string;
  plan?: string;
  botName: string;
};

const REVIEW_BODY_MARKER = "<!-- This is an auto-generated comment by DiffSentry for review status -->";

function isNitpick(c: ReviewComment): boolean {
  return c.type === "nitpick" || c.severity === "trivial";
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

  const commits = meta.baseSha
    ? `Reviewing files that changed from the base of the PR and between \`${meta.baseSha}\` and \`${meta.headSha}\`.`
    : `Reviewing files at \`${meta.headSha}\` (base SHA unavailable).`;

  return [
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
    "",
    renderFileList("Files selected for processing", meta.filesProcessed, "📒"),
    "",
    renderFileList("Files with no reviewable changes", meta.filesNoReviewableChanges, "💤"),
    "",
    renderFileList("Files skipped from review due to trivial changes", meta.filesSkippedTrivial, "✅"),
    "",
    renderFileList(
      "Files skipped from review as they are similar to previous changes",
      meta.filesSkippedSimilar,
      "🚧",
    ),
    "",
    `</details>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export function formatReviewBody(
  result: ReviewResult,
  meta: ReviewBodyMeta,
): string {
  const actionable = result.comments.filter((c) => !isNitpick(c));
  const nitpicks = result.comments.filter(isNitpick);
  const runId = randomUUID();

  const sections: string[] = [];
  sections.push(`**Actionable comments posted: ${actionable.length}**`);

  if (result.summary && result.summary.trim()) {
    sections.push(result.summary.trim());
  }

  const nitpicksBlock = renderNitpicksSection(nitpicks);
  if (nitpicksBlock) sections.push(nitpicksBlock);

  const bulkPrompt = renderBulkAiPrompt(result.comments);
  if (bulkPrompt) sections.push(bulkPrompt);

  if (result.comments.length > 0) {
    sections.push(renderAutofixSection());
  }

  sections.push("---");
  sections.push(renderReviewInfo(meta, runId));
  sections.push(REVIEW_BODY_MARKER);

  return sections.join("\n\n");
}
