import { IssueChatCommand } from "./types.js";

/**
 * Parse a chat command from a comment posted on a GitHub issue (not a PR).
 * Returns null if the bot is not mentioned. The issue command vocabulary is a
 * subset of the PR commands — diff/review/full-review/simplify/autofix/etc.
 * don't apply because there is no diff. Free-form `@bot <question>` falls
 * through to a chat response grounded in the issue context.
 */
export function parseIssueCommand(
  body: string,
  botName: string
): IssueChatCommand | null {
  const mentionPattern = new RegExp(`@${botName}\\b`, "i");
  const match = mentionPattern.exec(body);
  if (!match) return null;

  const afterMention = body.slice(match.index + match[0].length).trim();
  const lower = afterMention.toLowerCase();

  // learn / remember <text> — saved to the per-repo learnings store
  if (lower.startsWith("learn") || lower.startsWith("remember")) {
    const keyword = lower.startsWith("learn") ? "learn" : "remember";
    const content = afterMention.slice(keyword.length).trim();
    return { type: "learn", content };
  }

  // plan [optional focus] — generate an implementation plan
  if (lower.startsWith("plan")) {
    const target = afterMention.replace(/^plan/i, "").trim();
    return { type: "plan", target: target || undefined };
  }

  const single: Record<string, IssueChatCommand> = {
    help: { type: "help" },
    summary: { type: "summary" },
    summarize: { type: "summary" },
    pause: { type: "pause" },
    resume: { type: "resume" },
    configuration: { type: "configuration" },
    config: { type: "configuration" },
  };

  const firstWord = lower.split(/\s/)[0];
  if (firstWord in single) {
    return single[firstWord];
  }

  // Fallback: free-form question or request, answered by chatIssue.
  return { type: "chat", message: afterMention };
}

/**
 * Markdown help message for issues. Distinct from the PR help — only commands
 * that apply to issues are listed here so users don't get confused.
 */
export function formatIssueHelpMessage(botName: string): string {
  return `## DiffSentry — Issue Commands

| Command | Description |
|---------|-------------|
| \`@${botName} summary\` | Regenerate the issue triage summary |
| \`@${botName} plan [focus]\` | Generate a step-by-step implementation plan (optional focus narrows the scope) |
| \`@${botName} pause\` | Stop auto-responding on this issue |
| \`@${botName} resume\` | Resume auto-responding on this issue |
| \`@${botName} configuration\` | Show the active \`.diffsentry.yaml\` configuration |
| \`@${botName} learn <text>\` | Save a learning for future reviews of this repo |
| \`@${botName} help\` | Show this help message |

You can also ask any question by mentioning \`@${botName}\` followed by your question — the response is grounded in the issue body, recent comments, and the repository's top-level layout.`;
}
