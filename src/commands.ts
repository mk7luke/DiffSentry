import { ChatCommand } from "./types.js";

/**
 * Parse a chat command from a PR comment body that mentions the bot.
 * Returns null if the bot is not mentioned.
 */
export function parseCommand(
  body: string,
  botName: string
): ChatCommand | null {
  const mentionPattern = new RegExp(`@${botName}\\b`, "i");
  const match = mentionPattern.exec(body);
  if (!match) return null;

  const afterMention = body.slice(match.index + match[0].length).trim();

  const commandMap: Record<string, ChatCommand> = {
    review: { type: "review" },
    "full review": { type: "full_review" },
    pause: { type: "pause" },
    resume: { type: "resume" },
    resolve: { type: "resolve" },
    help: { type: "help" },
    configuration: { type: "configuration" },
    summary: { type: "summary" },
    simplify: { type: "simplify" },
    autofix: { type: "autofix" },
    tldr: { type: "tldr" },
    tour: { type: "tour" },
    ship: { type: "ship" },
    "rubber-duck": { type: "rubber_duck" },
    rubberduck: { type: "rubber_duck" },
    eli5: { type: "eli5" },
  };

  const lower = afterMention.toLowerCase();

  // Check multi-word commands first
  if (lower.startsWith("full review")) {
    return commandMap["full review"];
  }
  if (lower.startsWith("generate docstrings") || lower.startsWith("generate docstring")) {
    return { type: "generate_docstrings" };
  }
  if (lower.startsWith("generate unit tests") || lower.startsWith("generate tests")) {
    return { type: "generate_tests" };
  }

  // Check learn/remember commands
  if (lower.startsWith("learn") || lower.startsWith("remember")) {
    const keyword = lower.startsWith("learn") ? "learn" : "remember";
    const content = afterMention.slice(keyword.length).trim();
    return { type: "learn", content };
  }

  // 5why <target> — Toyota-style recursive why analysis
  if (lower.startsWith("5why") || lower.startsWith("5-why") || lower.startsWith("5 why")) {
    const target = afterMention.replace(/^5[- ]?why/i, "").trim();
    return { type: "five_why", target };
  }

  // Check single-word commands
  const firstWord = lower.split(/\s/)[0];
  if (firstWord in commandMap) {
    return commandMap[firstWord];
  }

  // Fallback: treat as a chat message
  return { type: "chat", message: afterMention };
}

/**
 * Return a markdown help message listing all available commands.
 */
export function formatHelpMessage(botName: string): string {
  return `## DiffSentry Commands

| Command | Description |
|---------|-------------|
| \`@${botName} review\` | Trigger an incremental review |
| \`@${botName} full review\` | Trigger a full review of all files |
| \`@${botName} pause\` | Pause automatic reviews on this PR |
| \`@${botName} resume\` | Resume automatic reviews on this PR |
| \`@${botName} resolve\` | Resolve all review comment threads |
| \`@${botName} summary\` | Regenerate the PR summary |
| \`@${botName} configuration\` | Show active configuration |
| \`@${botName} help\` | Show this help message |
| \`@${botName} learn <text>\` | Save a learning for future reviews |
| \`@${botName} generate docstrings\` | Add missing docstrings and commit to branch |
| \`@${botName} generate tests\` | Generate unit tests and commit to branch |
| \`@${botName} simplify\` | Simplify changed code and commit to branch |
| \`@${botName} autofix\` | Apply fixes from review comments and commit to branch |
| \`@${botName} tldr\` | One-paragraph TL;DR of the PR |
| \`@${botName} tour\` | Suggested reading order with reasoning per file |
| \`@${botName} ship\` | Pre-flight verdict — is this PR ready to merge? |
| \`@${botName} rubber-duck\` | Socratic questions to challenge the design |
| \`@${botName} 5why <target>\` | Recursive 5-whys analysis of a behavior or decision |
| \`@${botName} eli5\` | Explain the PR like the reviewer is 5 (great for cross-team review) |

You can also ask questions or request explanations by mentioning \`@${botName}\` followed by your question.`;
}

/**
 * Return a markdown formatted display of the active configuration.
 */
export function formatConfigMessage(
  repoConfig: any,
  envConfig: { aiProvider: string; maxFilesPerReview: number; botName: string }
): string {
  const yamlLines: string[] = [];

  if (repoConfig && typeof repoConfig === "object") {
    const formatYaml = (obj: any, indent: number = 0): void => {
      const prefix = "  ".repeat(indent);
      for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null) continue;
        if (typeof value === "object" && !Array.isArray(value)) {
          yamlLines.push(`${prefix}${key}:`);
          formatYaml(value, indent + 1);
        } else if (Array.isArray(value)) {
          yamlLines.push(`${prefix}${key}:`);
          for (const item of value) {
            if (typeof item === "object") {
              yamlLines.push(`${prefix}  -`);
              formatYaml(item, indent + 2);
            } else {
              yamlLines.push(`${prefix}  - ${item}`);
            }
          }
        } else {
          yamlLines.push(`${prefix}${key}: ${value}`);
        }
      }
    };
    formatYaml(repoConfig);
  }

  const repoSection =
    yamlLines.length > 0
      ? `### Repository Configuration (.diffsentry.yaml)\n\n\`\`\`yaml\n${yamlLines.join("\n")}\n\`\`\``
      : `### Repository Configuration (.diffsentry.yaml)\n\n_No repository configuration file found. Using defaults._`;

  return `## DiffSentry Configuration

${repoSection}

### Server Configuration

| Setting | Value |
|---------|-------|
| AI Provider | \`${envConfig.aiProvider}\` |
| Max Files Per Review | \`${envConfig.maxFilesPerReview}\` |
| Bot Name | \`@${envConfig.botName}\` |`;
}
