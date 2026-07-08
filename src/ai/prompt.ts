import { PRContext, RepoConfig, Learning, IssueContext } from "../types.js";

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
  "prLevelComments": [
    {
      "title": "Single-sentence headline describing the finding (ends with a period).",
      "body": "1-3 paragraph prose explanation. Reference identifiers/files in backticks.",
      "type": "issue | suggestion | nitpick | documentation | security",
      "severity": "critical | major | minor | trivial",
      "aiAgentPrompt": "Imperative instruction to a coding agent. Name the files/symbols and say WHAT to change.",
      "confidence": "high | medium | low"
    }
  ],
  "approval": "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
}

Rules for the JSON response:
- "line" must be a line number that appears in the diff (from the + side of the patch).
- "prLevelComments" is for findings that are NOT tied to one specific changed line and therefore cannot be an inline comment. Use it — do NOT invent a line number or bury the finding only in the summary — for: the diff contradicting the PR description (a claimed change is missing, or the code does something the description doesn't mention), issues spanning many files, or concerns about the change as a whole. Each entry has NO "path"/"line". Same title/body/type/severity/aiAgentPrompt/confidence fields as inline comments. Omit the field or use [] when there are none.
- A REQUEST_CHANGES verdict MUST be backed by at least one concrete finding — an inline "comments" entry or a "prLevelComments" entry. Never request changes while leaving both arrays empty and describing the problem only in "summary".
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

function buildReviewSystemPrompt(repoConfig?: RepoConfig, learnings?: Learning[]): string {
  const profile = repoConfig?.reviews?.profile || "chill";
  const instructions = profile === "assertive" ? ASSERTIVE_INSTRUCTIONS : CHILL_INSTRUCTIONS;
  const tone = repoConfig?.tone_instructions
    ? `\n\nTone guidance: ${repoConfig.tone_instructions}`
    : "";

  let learningsBlock = "";
  if (learnings && learnings.length > 0) {
    const items = learnings.map((l, i) => `${i + 1}. ${l.content}`).join("\n");
    learningsBlock = `\n\n## Repository Learnings (AUTHORITATIVE — overrides default heuristics)

The maintainers of this repository have explicitly taught the reviewer the following rules. Treat them as direct instructions from the team:

${items}

How to apply:
- If a learning says a class of finding is "not relevant" / "ignore" / "we don't enforce X", DO NOT raise that finding again. Stay silent.
- If a learning asserts a convention ("we always do X"), enforce it: flag code that violates it; approve code that follows it.
- If a learning conflicts with your default profile guidance, the LEARNING WINS.
- Never explain that you are following a learning — just apply it. The user already knows.`;
  }

  return REVIEW_SYSTEM_BASE + instructions + tone + learningsBlock;
}

export function buildReviewPrompt(
  context: PRContext,
  repoConfig?: RepoConfig,
  learnings?: Learning[]
): { system: string; user: string } {
  const system = buildReviewSystemPrompt(repoConfig, learnings);

  const budget = context.diffBudget;

  const filesSection = context.files
    // Files dropped entirely for size carry no diff to review — surface them in
    // the omitted note below instead of an empty code fence.
    .filter((f) => !budget?.byFile[f.filename]?.omitted)
    .map((f) => {
      // Gather path-specific instructions
      const pathInstructions = getPathInstructionsForFile(f.filename, repoConfig);
      const pathNote = pathInstructions.length > 0
        ? `\n**Path-specific review guidance:**\n${pathInstructions.map((i) => `- ${i}`).join("\n")}\n`
        : "";

      const budgeted = budget?.byFile[f.filename];
      const patch = budgeted ? budgeted.patch : f.patch;
      const truncNote = budgeted?.truncated
        ? `\n> ⚠️ This patch was truncated to fit the review size budget — hunk headers plus a head/tail of each hunk are shown. Flag findings only against the lines you can see.\n`
        : "";

      return `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})${pathNote}${truncNote}\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");

  // Note files dropped from the prompt entirely so the model knows the diff it
  // sees is partial (and won't claim a clean review of the whole PR).
  const omittedNote =
    budget && budget.filesOmitted.length > 0
      ? `\n\n> ⚠️ **${budget.filesOmitted.length} file(s) were omitted from the diff above to stay within the review size budget** (lower-risk / larger files dropped first): ${budget.filesOmitted
          .map((p) => `\`${p}\``)
          .join(", ")}. These were not shown to you — do not assume they are correct or approve them.`
      : "";

  // Bounded graph-backed context (whole-function bodies, cross-file
  // dependents/dependencies, high-fan-in flags). Already token-budgeted by the
  // builder; injected only when present so diff-only behaviour is preserved.
  const relatedSection =
    context.relatedContext && context.relatedContext.trim().length > 0
      ? `\n\n${context.relatedContext}`
      : "";

  const user = `## Pull Request: ${context.title}

**Branch:** ${context.headBranch} → ${context.baseBranch}

**Description:**
${context.description || "(no description provided)"}

## Changed Files

${filesSection}${omittedNote}${relatedSection}

Review this pull request and respond with JSON. Remember to obey the Repository Learnings in the system prompt — they override your default flagging heuristics.`;

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
- "sequenceDiagrams": array of 0-3 Mermaid sequenceDiagram blocks showing key flows introduced/modified. Omit (empty array) if the changes don't involve a clear interaction flow. Each entry is a complete sequenceDiagram (without surrounding triple backticks). Do NOT put semicolons (\`;\`) inside message labels — Mermaid treats them as statement terminators and the diagram will fail to render (e.g. write "TL/DR" or "summary" instead of "TL;DR").
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

  const budget = context.diffBudget;

  // The file LIST always names every changed file (so cohorts/descriptions can
  // cover them); only the heavyweight patch section honors the size budget.
  const filesSection = context.files
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`)
    .join("\n");

  const patchSection = context.files
    .filter((f) => !budget?.byFile[f.filename]?.omitted)
    .map((f) => {
      const budgeted = budget?.byFile[f.filename];
      const patch = budgeted ? budgeted.patch : f.patch;
      const truncNote = budgeted?.truncated ? " _(patch truncated to fit the size budget)_" : "";
      return `### ${f.filename}${truncNote}\n\`\`\`diff\n${patch}\n\`\`\``;
    })
    .join("\n\n");

  // Mirror buildReviewPrompt: when files were dropped from the diff for size,
  // name them and tell the model to summarize only from the patches it can see.
  const omittedNote =
    budget && budget.filesOmitted.length > 0
      ? `\n\n> ⚠️ **${budget.filesOmitted.length} file(s) had their diffs omitted to stay within the size budget** (they appear in the file list above but not in the diffs below): ${budget.filesOmitted
          .map((p) => `\`${p}\``)
          .join(", ")}. Base your summary and sequence diagrams only on the patches shown below; note these files as changed but not detailed.`
      : "";

  const user = `## Pull Request: ${context.title}

**Branch:** ${context.headBranch} → ${context.baseBranch}

**Description:**
${context.description || "(no description provided)"}

## Changed Files
${filesSection}${omittedNote}

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

// ─── Issue Prompts ─────────────────────────────────────────────

const ISSUE_CHAT_SYSTEM = `You are DiffSentry, an AI assistant responding to a GitHub issue. You have the issue title, body, labels, recent comments, and a top-level view of the repository's file tree.

Be concise, concrete, and actionable. Use GitHub-flavored markdown:
- Reference files in backticks (e.g. \`src/server.ts\`).
- Use fenced code blocks for snippets.
- Use bullet lists for steps and short lists.
- Prefer short paragraphs over long ones.

When the user's request is ambiguous, ask one focused clarifying question. When it is clear, answer directly. Don't hedge with disclaimers — say what you know, flag uncertainty inline ("I'm not sure but…") only when relevant.

Do not invent files, functions, or APIs you can't see in the provided context. If you would need code you don't have, say so and suggest where to look.`;

function formatIssueContextForPrompt(context: IssueContext, repoConfig?: RepoConfig): string {
  const labels = context.labels.length > 0 ? context.labels.join(", ") : "(none)";
  const tone = repoConfig?.tone_instructions
    ? `\n**Tone guidance:** ${repoConfig.tone_instructions}\n`
    : "";

  const recentComments = (context.comments || [])
    .filter((c) => !c.isBot)
    .slice(-8)
    .map((c) => {
      const who = c.author ? `@${c.author}` : "unknown";
      const trimmed = (c.body || "").trim();
      const body = trimmed.length > 600 ? trimmed.slice(0, 600) + "…" : trimmed;
      return `- ${who} (${c.authorAssociation || "user"}): ${body}`;
    })
    .join("\n");

  const tree = (context.repoFileTree || []).join(", ");
  const treeBlock = tree ? `\n**Repository top-level entries:** ${tree}\n` : "";

  return `## Issue #${context.issueNumber}: ${context.title}

**State:** ${context.state} | **Labels:** ${labels} | **Author:** ${context.author ? "@" + context.author : "unknown"}
${tone}${treeBlock}
**Body:**
${context.body?.trim() || "(no body provided)"}

${recentComments ? `**Recent comments:**\n${recentComments}\n` : ""}`;
}

export function buildIssueChatPrompt(
  context: IssueContext,
  userMessage: string,
  repoConfig?: RepoConfig,
  learnings?: Learning[]
): { system: string; user: string } {
  const learningsSection = learnings && learnings.length > 0
    ? `\n## Repository Learnings\n${learnings.map((l, i) => `${i + 1}. ${l.content}`).join("\n")}\n`
    : "";

  const user = `${formatIssueContextForPrompt(context, repoConfig)}${learningsSection}
---

## User Question/Request:

${userMessage}

Respond in markdown.`;

  return { system: ISSUE_CHAT_SYSTEM, user };
}

/**
 * Build the auto-summary prompt — what the bot posts on issues.opened.
 * Mirrors CodeRabbit's "issue triage" output: 1-paragraph summary, key
 * questions, suggested labels, and a short pointer to areas of the codebase.
 */
export function buildIssueSummaryInstruction(): string {
  return `Generate a CodeRabbit-style issue triage summary. Use these sections, in order, with these EXACT markdown headings (do not add or rename sections):

## Summary
1-3 sentence plain-English restatement of what this issue is asking for, written in present tense. Don't quote the issue verbatim.

## Key Questions
2-4 specific clarifying questions a maintainer would want answered before starting work. Skip this section entirely if the issue is already crystal clear — say "_The issue is well-specified — no clarifications needed._" instead.

## Suggested Labels
Bullet list of 1-4 labels from this set when they fit: \`bug\`, \`enhancement\`, \`refactor\`, \`documentation\`, \`performance\`, \`security\`, \`good first issue\`, \`needs triage\`. Use other labels only if they're already on the issue. One short reason per label.

## Where to Look
Bullet list of 2-5 files/directories from the repository tree most likely involved. Use backticks for paths. One short reason per entry. Be specific — don't list everything.

## Suggested Next Steps
Bullet list of 2-4 concrete actions the assignee should take, in order. Each step references a file/symbol when possible.

Keep the whole response under ~250 words. No preamble, no sign-off.`;
}

/**
 * Implementation-plan prompt — what `@bot plan` produces. Heavier than the
 * triage summary; designed to be directly actionable.
 */
export function buildIssuePlanInstruction(extra?: string): string {
  const focus = extra && extra.trim().length > 0
    ? `\n\nAdditional focus from the user: ${extra.trim()}`
    : "";
  return `Generate an implementation plan for this issue. Use these sections, in order:

## Goal
1-2 sentences naming the deliverable (what "done" looks like).

## Approach
Short paragraph (~3-5 sentences) describing the high-level approach and the key design choice you're recommending.

## Step-by-Step
Numbered list of 3-8 concrete steps. Each step:
- Names the file(s) to touch in backticks.
- Names the function(s)/symbol(s) when possible.
- Describes what changes (one sentence).
- If there's a non-obvious "why," include a parenthetical note.

## Tests
Bullet list of 2-5 test cases worth adding, with the test type (unit / integration / e2e) and a one-line description of the scenario.

## Risks & Open Questions
Bullet list of 1-4 risks, edge cases, or things you'd want a maintainer to confirm. If none, write "_None identified._"

Be concrete. Reference identifiers and file paths from the repository tree above. Don't invent files. If you can't ground a step in a real file, say so explicitly. Keep the response under ~400 words.${focus}`;
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
