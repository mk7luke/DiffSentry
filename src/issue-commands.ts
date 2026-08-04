import { IssueChatCommand } from "./types.js";
import { extractSlashCommand, SlashOptions } from "./slash-commands.js";
import { unrecognized } from "./commands.js";

/**
 * Parse a chat command from a comment posted on a GitHub issue (not a PR).
 * Returns null if the comment isn't addressed to us. The issue command
 * vocabulary is a subset of the PR commands — diff/review/full-review/
 * simplify/autofix/etc. don't apply because there is no diff.
 *
 * As on PRs, `@bot <anything>` falls through to a chat response grounded in
 * the issue context, while slash commands are strict.
 */
export function parseIssueCommand(
  body: string,
  botName: string,
  slashOpts: SlashOptions = {}
): IssueChatCommand | null {
  // Slash first, matching the PR parser. A bare PR-only command (`/review` on
  // an issue) is an exact vocabulary match, so it earns no suggestion and
  // stays silent rather than nagging.
  const slash = extractSlashCommand(body, botName, slashOpts);
  if (slash) {
    return matchIssueCommand(slash.text) ?? unrecognized(slash.syntax, slash.name);
  }

  const mentionPattern = new RegExp(`@${botName}\\b`, "i");
  const match = mentionPattern.exec(body);
  if (!match) return null;

  const afterMention = body.slice(match.index + match[0].length).trim();
  return matchIssueCommand(afterMention) ?? { type: "chat", message: afterMention };
}

/**
 * Match issue command text against the issue vocabulary. Null means no match;
 * the caller decides whether that is chat, an error, or silence.
 */
function matchIssueCommand(text: string): IssueChatCommand | null {
  const afterMention = text.trim();
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

  return null;
}

/**
 * Markdown help message for issues. Distinct from the PR help — only commands
 * that apply to issues are listed here so users don't get confused.
 */
export function formatIssueHelpMessage(botName: string): string {
  return `## DiffSentry — Issue Commands

Start a comment with a slash command. \`/${botName} <command>\` always works; the
short form is a convenience that other bots on this repo may also claim.

| Command | Description |
|---------|-------------|
| \`/summary\` | Regenerate the issue triage summary |
| \`/plan [focus]\` | Generate a step-by-step implementation plan (optional focus narrows the scope) |
| \`/pause\` | Stop auto-responding on this issue |
| \`/resume\` | Resume auto-responding on this issue |
| \`/configuration\` | Show the active \`.diffsentry.yaml\` configuration |
| \`/learn <text>\` | Save a learning for future reviews of this repo |
| \`/help\` | Show this help message |

**To ask a question**, mention \`@${botName}\` followed by your question — the
response is grounded in the issue body, recent comments, and the repository's
top-level layout. Every command above also works as \`@${botName} <command>\`.`;
}
