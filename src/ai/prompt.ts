import { PRContext, RepoConfig, Learning } from "../types.js";

// ─── Review Prompts ────────────────────────────────────────────

const REVIEW_SYSTEM_BASE = `You are an expert code reviewer. You review pull requests thoroughly, providing actionable feedback.

You MUST respond with valid JSON matching this schema:
{
  "summary": "A 2-4 sentence summary of the overall PR quality and key findings.",
  "comments": [
    {
      "path": "relative/file/path.ts",
      "line": 42,
      "body": "Description of the issue and suggested fix.",
      "type": "issue | suggestion | nitpick",
      "severity": "critical | major | minor | trivial"
    }
  ],
  "approval": "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
}

Rules for the JSON response:
- "line" must be a line number that appears in the diff (from the + side of the patch).
- "path" must exactly match a filename from the changed files.
- "type": "issue" for bugs/security/errors, "suggestion" for improvements/refactoring, "nitpick" for style/minor.
- "severity": "critical" for system failures/security breaches, "major" for significant problems, "minor" for should-fix, "trivial" for low-impact.
- "approval": use APPROVE if no issues, REQUEST_CHANGES if there are bugs/security issues, COMMENT for suggestions.
- If there are no issues, return an empty comments array and APPROVE.
- Return ONLY the JSON object, no markdown fences or extra text.`;

const CHILL_INSTRUCTIONS = `
Focus areas (chill profile — critical issues only):
- Bugs, logic errors, and potential runtime failures
- Security vulnerabilities (injection, auth issues, data exposure)
- Breaking API changes
- Data loss scenarios

Guidelines:
- Only flag real problems that could cause production issues.
- Do NOT comment on style, naming, formatting, or minor improvements.
- Do NOT nitpick. If it works correctly and safely, approve it.
- Be concise. If the code looks good, say so briefly.
- When suggesting a fix, include a GitHub suggestion block (\`\`\`suggestion ... \`\`\`).`;

const ASSERTIVE_INSTRUCTIONS = `
Focus areas (assertive profile — comprehensive feedback):
- Bugs, logic errors, and potential runtime failures
- Security vulnerabilities (injection, auth issues, data exposure)
- Performance problems (N+1 queries, unnecessary allocations, missing indexes)
- Code clarity and maintainability
- Missing error handling or edge cases
- API contract issues or breaking changes
- Code style and naming conventions
- Dead code and unnecessary complexity
- Missing type annotations or documentation for complex logic

Guidelines:
- Be thorough. Flag issues, suggestions, AND nitpicks.
- Categorize each comment with the appropriate type and severity.
- Suggest fixes, not just problems. Include GitHub suggestion blocks (\`\`\`suggestion ... \`\`\`) when feasible.
- Use markdown formatting in your comments.`;

function buildReviewSystemPrompt(repoConfig?: RepoConfig): string {
  const profile = repoConfig?.reviews?.profile || "chill";
  const instructions = profile === "assertive" ? ASSERTIVE_INSTRUCTIONS : CHILL_INSTRUCTIONS;
  const tone = repoConfig?.tone_instructions
    ? `\n\nTone guidance: ${repoConfig.tone_instructions}`
    : "";

  return REVIEW_SYSTEM_BASE + instructions + tone;
}

export function buildReviewPrompt(
  context: PRContext,
  repoConfig?: RepoConfig,
  learnings?: Learning[]
): { system: string; user: string } {
  const system = buildReviewSystemPrompt(repoConfig);

  const filesSection = context.files
    .map((f) => {
      // Gather path-specific instructions
      const pathInstructions = getPathInstructionsForFile(f.filename, repoConfig);
      const pathNote = pathInstructions.length > 0
        ? `\n**Path-specific review guidance:**\n${pathInstructions.map((i) => `- ${i}`).join("\n")}\n`
        : "";

      return `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})${pathNote}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    })
    .join("\n\n");

  let learningsSection = "";
  if (learnings && learnings.length > 0) {
    learningsSection = `\n## Repository Learnings\n\nThe team has provided these preferences and guidelines:\n${learnings.map((l, i) => `${i + 1}. ${l.content}`).join("\n")}\n\nApply these learnings when relevant to the code being reviewed.\n`;
  }

  const user = `## Pull Request: ${context.title}

**Branch:** ${context.headBranch} → ${context.baseBranch}

**Description:**
${context.description || "(no description provided)"}
${learningsSection}
## Changed Files

${filesSection}

Review this pull request and respond with JSON.`;

  return { system, user };
}

// ─── Walkthrough Prompts ───────────────────────────────────────

const WALKTHROUGH_SYSTEM = `You are an expert code reviewer generating a high-level walkthrough of a pull request.

You MUST respond with valid JSON matching this schema:
{
  "summary": "A 2-4 sentence high-level summary of what this PR does and why.",
  "fileDescriptions": [
    {
      "filename": "relative/file/path.ts",
      "status": "modified",
      "changeDescription": "Brief description of what changed in this file."
    }
  ],
  "effortEstimate": 3,
  "sequenceDiagram": "sequenceDiagram\\n    Actor User\\n    User->>Server: request\\n    Server-->>User: response",
  "suggestedLabels": ["enhancement", "api"],
  "suggestedReviewers": [],
  "poem": ""
}

Rules:
- "effortEstimate" is 1-5 where 1=trivial, 2=small, 3=medium, 4=large, 5=very large. Base on: lines changed, complexity, number of files, risk.
- "sequenceDiagram" should be valid Mermaid syntax showing the key flow introduced or modified. Omit (empty string) if the changes don't involve a clear interaction flow.
- "suggestedLabels" should be from common labels: bug, enhancement, refactor, docs, test, performance, security, breaking-change, dependencies. Only suggest what fits.
- "suggestedReviewers" leave empty (we don't have team data).
- "poem" should be a short (2-4 line) haiku or limerick about the PR. Can be empty string if not requested.
- "fileDescriptions" must cover ALL changed files.
- Return ONLY the JSON object, no markdown fences or extra text.`;

export function buildWalkthroughPrompt(
  context: PRContext,
  repoConfig?: RepoConfig
): { system: string; user: string } {
  const wantPoem = repoConfig?.reviews?.walkthrough?.poem ?? false;
  const poemNote = wantPoem
    ? "\nInclude a short poem about this PR."
    : "\nDo NOT include a poem (leave empty string).";

  const filesSection = context.files
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`)
    .join("\n");

  const patchSection = context.files
    .map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n\n");

  const user = `## Pull Request: ${context.title}

**Branch:** ${context.headBranch} → ${context.baseBranch}

**Description:**
${context.description || "(no description provided)"}

## Changed Files
${filesSection}

## Diffs
${patchSection}

Generate a walkthrough of this PR.${poemNote}`;

  return { system: WALKTHROUGH_SYSTEM, user };
}

// ─── Chat Prompts ──────────────────────────────────────────────

const CHAT_SYSTEM = `You are DiffSentry, an AI code review assistant. You are responding to a question or comment about a pull request.

You have full context of the PR including the title, description, changed files, and diffs. Answer the user's question helpfully and concisely. Use markdown formatting. If they ask about specific code, reference the relevant files and lines.

If you don't know the answer or the question is outside the scope of the PR, say so honestly.`;

export function buildChatPrompt(
  context: PRContext,
  userMessage: string
): { system: string; user: string } {
  const filesSection = context.files
    .map((f) => `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n\n");

  const user = `## PR Context: ${context.title}

**Branch:** ${context.headBranch} → ${context.baseBranch}

**Description:**
${context.description || "(no description provided)"}

## Changed Files

${filesSection}

---

## User Question/Comment:

${userMessage}

Respond to the user's question about this PR.`;

  return { system: CHAT_SYSTEM, user };
}

// ─── Helpers ───────────────────────────────────────────────────

function getPathInstructionsForFile(filename: string, repoConfig?: RepoConfig): string[] {
  if (!repoConfig?.reviews?.path_instructions) return [];

  return repoConfig.reviews.path_instructions
    .filter((pi) => {
      // Simple glob matching
      if (pi.path.includes("*")) {
        const regex = new RegExp(
          "^" + pi.path.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
        );
        return regex.test(filename);
      }
      return filename.startsWith(pi.path) || filename === pi.path;
    })
    .map((pi) => pi.instructions);
}
