import { PRContext, RepoConfig, Learning } from "../types.js";

// ─── Review Prompts ────────────────────────────────────────────

const REVIEW_SYSTEM_BASE = `You are an expert code reviewer. You review pull requests thoroughly, providing actionable feedback in the style of CodeRabbit.

You MUST respond with valid JSON matching this schema:
{
  "summary": "A 2-4 sentence summary of the overall PR quality and key findings.",
  "comments": [
    {
      "path": "relative/file/path.ts",
      "line": 42,
      "title": "Single-sentence headline describing the finding (ends with a period).",
      "body": "1-3 paragraph prose explanation. May include numbered/bulleted reasoning. Reference identifiers in backticks.",
      "type": "issue | suggestion | nitpick | documentation | security",
      "severity": "critical | major | minor | trivial",
      "suggestion": "OPTIONAL multi-line code fix. Provide the full replacement block (no fences).",
      "suggestionLanguage": "diff | suggestion",
      "aiAgentPrompt": "Imperative instruction to a coding agent. Reference symbols by name. Tell the agent WHAT to change and WHERE.",
      "confidence": "high | medium | low"
    }
  ],
  "approval": "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
}

Rules for the JSON response:
- "line" must be a line number that appears in the diff (from the + side of the patch).
- "path" must exactly match a filename from the changed files.
- "title" is REQUIRED on every comment. One sentence, ends with a period, no markdown formatting. This becomes the bold headline.
- "body" is the explanation BELOW the title. Do NOT repeat the title in the body.
- "type":
  - "issue" — bug, logic error, runtime failure (renders as "Potential issue" with ⚠️)
  - "suggestion" — refactor or improvement (renders as "Refactor suggestion" with 🛠️)
  - "nitpick" — style, naming, minor cleanup (renders as "Nitpick" with 🧹)
  - "documentation" — missing/incorrect docs (renders as "Documentation" with 📝)
  - "security" — vulnerability or unsafe pattern (renders as "Security" with 🔒)
- "severity": "critical" for system failures/security breaches, "major" for significant problems, "minor" for should-fix, "trivial" for low-impact.
- "suggestion" is OPTIONAL. When provided, it must be a self-contained code block ready to drop in. Use "suggestionLanguage": "suggestion" when it replaces the exact target line(s); use "diff" when context lines or multi-region changes are needed (use proper diff format with leading +/- ).
- "aiAgentPrompt" is REQUIRED on every comment. Format: "In <path> around line N, <imperative description naming the variables/functions/symbols involved>; <how to fix>; <optional secondary fix or reference>." Aim for 2-4 sentences. The prompt must be directly executable by Claude/Cursor/Copilot agents — name the identifiers, do not be vague.
- "confidence" is OPTIONAL but recommended. Set "high" when the issue is unambiguous and verified against the diff. Set "medium" when the diagnosis depends on intent you can't see. Set "low" when you're flagging it as a hypothesis to verify. If omitted, the renderer defaults to "high".
- "approval": use APPROVE if no issues, REQUEST_CHANGES if there are critical/major issues, COMMENT for suggestions/nitpicks only.
- If there are no findings, return an empty comments array and APPROVE.
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
- Always include a "title", "body", and "aiAgentPrompt" on every comment.
- Provide a "suggestion" with the corrected code whenever a fix is feasible.`;

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
- Always include a "title", "body", and "aiAgentPrompt" on every comment.
- Provide a "suggestion" with the corrected code whenever a fix is feasible. Prefer "suggestionLanguage": "diff" for multi-line or context-dependent changes, "suggestion" for single-line replacements.
- Use markdown formatting (backticks for identifiers, bullets for lists) in the body.`;

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

const WALKTHROUGH_SYSTEM = `You are an expert code reviewer generating a CodeRabbit-style high-level walkthrough of a pull request.

You MUST respond with valid JSON matching this schema:
{
  "summary": "A 1-2 sentence high-level summary of what this PR does, written in past tense.",
  "fileDescriptions": [
    {
      "filename": "relative/file/path.ts",
      "status": "modified",
      "changeDescription": "Brief description of what changed in this file."
    }
  ],
  "cohorts": [
    {
      "label": "Build & Distribution",
      "files": ["package.json", "README.md"],
      "summary": "Reworked npm scripts, added cross-env, updated electron-builder config."
    }
  ],
  "effortEstimate": 3,
  "effortMinutes": 25,
  "sequenceDiagrams": [
    "sequenceDiagram\\n    participant User\\n    participant Server\\n    User->>Server: request\\n    Server-->>User: response"
  ],
  "suggestedLabels": ["enhancement", "api"],
  "suggestedReviewers": [],
  "poem": ""
}

Rules:
- "summary" must be 1-2 short sentences in past tense (e.g. "Adds cross-platform build scripts and patches node-pty for Windows.").
- "fileDescriptions" must cover ALL changed files (used as a fallback when cohorts omit a file).
- "cohorts" groups changed files into 1-8 thematic clusters. Each cohort:
  - "label": 2-5 word category in title case (no emoji). Examples: "Build & Distribution", "Native rebuild / postinstall", "UI zoom IPC & persistence".
  - "files": array of file paths belonging to this cohort. Every changed file must appear in exactly one cohort.
  - "summary": 1-2 sentence description of what changed across these files.
- "effortEstimate": 1-5 where 1=Trivial, 2=Simple, 3=Moderate, 4=Complex, 5=Very Complex.
- "effortMinutes": rough integer estimate of review minutes (e.g. 5, 15, 30, 60, 120).
- "sequenceDiagrams": array of 0-3 Mermaid sequenceDiagram blocks showing key flows introduced/modified. Omit (empty array) if the changes don't involve a clear interaction flow. Each entry is a complete sequenceDiagram (without surrounding triple backticks).
- "suggestedLabels": from common labels: bug, enhancement, refactor, docs, test, performance, security, breaking-change, dependencies. Only suggest what fits.
- "suggestedReviewers": leave empty (no team data available).
- "poem": short (4-6 line) poem starting with rabbit emoji. Each line ends with two trailing spaces. Empty string if not requested.
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
