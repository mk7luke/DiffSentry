import { ChatCommand } from "./types.js";
import { extractSlashCommand, SlashOptions, SlashSyntax } from "./slash-commands.js";

/**
 * Parse a chat command from a PR comment body.
 *
 * Two addressing forms are accepted. An `@bot` mention is conversational: an
 * unrecognized phrase falls through to free-form chat. A slash command is
 * imperative: an unrecognized one is either flagged (`/diffsentry frobnicate`)
 * or ignored (`/frobnicate`, which may well belong to another bot), and never
 * becomes an AI chat call.
 *
 * Returns null when the comment isn't addressed to us at all.
 */
export function parseCommand(
  body: string,
  botName: string,
  slashOpts: SlashOptions = {}
): ChatCommand | null {
  // Slash first: it is line-anchored, so it is a deliberate instruction, while
  // a mention may just be an @-tag ("/review — cc @diffsentry"). A mention with
  // a mid-line slash ("@diffsentry what does /review do?") is unaffected,
  // because extraction only fires at the start of a line.
  const slash = extractSlashCommand(body, botName, slashOpts);
  if (slash) {
    return matchCommand(slash.text) ?? unrecognized(slash.syntax, slash.name);
  }

  const mentionPattern = new RegExp(`@${botName}\\b`, "i");
  const match = mentionPattern.exec(body);
  if (!match) return null;

  // Mention path keeps its conversational fallback.
  const afterMention = body.slice(match.index + match[0].length).trim();
  return matchCommand(afterMention) ?? { type: "chat", message: afterMention };
}

/**
 * True when a body resolves to a real slash command (not a mention, not an
 * unrecognized word). The webhook uses this to decide whether an implicit
 * thread reply should be rewritten into a chat message.
 */
export function resolvesToSlashCommand(
  body: string,
  botName: string,
  slashOpts: SlashOptions = {}
): boolean {
  const slash = extractSlashCommand(body, botName, slashOpts);
  return slash !== null && matchCommand(slash.text) !== null;
}

/**
 * Decide what an unrecognized slash command means.
 *
 * Namespaced commands are unambiguously ours, so we always answer. Bare ones
 * are shared ground: we answer only when the word is a near-miss for one of
 * our commands (a typo), and stay silent otherwise so another bot's `/lgtm`
 * never draws a reply from us.
 */
export function unrecognized(
  syntax: SlashSyntax,
  name: string
): { type: "unknown_command"; name: string; syntax: SlashSyntax } | null {
  if (syntax === "slash-namespaced") return { type: "unknown_command", name, syntax };
  return suggestCommand(name) ? { type: "unknown_command", name, syntax } : null;
}

/**
 * Single-word commands. Module-scope so the suggestion corpus can be derived
 * from it rather than hand-maintained alongside it — a parallel list drifts the
 * moment a command is added.
 */
const COMMAND_MAP: Record<string, ChatCommand> = {
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
  timeline: { type: "timeline" },
  bench: { type: "bench" },
  benchmark: { type: "bench" },
  changelog: { type: "changelog" },
  "release-notes": { type: "release_notes" },
  releasenotes: { type: "release_notes" },
  rewrite: { type: "rewrite_description" },
};

/**
 * Prefix-matched commands, i.e. everything matchCommand recognizes that
 * COMMAND_MAP does not: multi-word forms, their slash spellings, and aliases.
 * Kept adjacent to the matcher branches below so the two move together.
 */
const PREFIX_COMMANDS = [
  "full review", "full-review",
  "generate docstrings", "generate docstring", "generate-docstrings",
  "generate unit tests", "generate tests", "generate-tests",
  "learn", "remember",
  "5why", "diff",
];

/**
 * Match command text (the phrase after `@bot` or after the slash) against the
 * command vocabulary. Returns null when nothing matches — callers decide what
 * an unmatched phrase means, which differs by addressing form.
 */
function matchCommand(text: string): ChatCommand | null {
  const afterMention = text.trim();

  const lower = afterMention.toLowerCase();

  // Check multi-word commands first
  if (lower.startsWith("full review")) {
    return COMMAND_MAP["full review"];
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

  // diff <pr-number> — compare with another PR
  if (lower.startsWith("diff")) {
    const target = afterMention.replace(/^diff\s+/i, "").trim();
    if (target) return { type: "diff_pr", target };
  }

  // Check single-word commands
  const firstWord = lower.split(/\s/)[0];
  if (firstWord in COMMAND_MAP) {
    return COMMAND_MAP[firstWord];
  }

  return null;
}

/**
 * Every command word users can type, for "did you mean" suggestions. Derived
 * from the matcher's own tables so a new command cannot be added without also
 * becoming suggestible. `plan` is issue-only and has no entry in COMMAND_MAP,
 * so it is appended explicitly.
 */
const COMMAND_NAMES = [
  ...Object.keys(COMMAND_MAP),
  ...PREFIX_COMMANDS,
  "plan",
  "summarize",
  "config",
];

/**
 * Argument placeholders, mirroring the help tables, so a suggestion shows the
 * whole recovery path rather than a bare verb the user still has to look up.
 */
const COMMAND_ARGS: Record<string, string> = {
  learn: " <text>",
  remember: " <text>",
  diff: " <PR-number>",
  "5why": " <target>",
  plan: " [focus]",
};

/** Levenshtein distance, bounded use only (command words are short). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

/**
 * Closest known command within a small edit distance, or null.
 *
 * Doubles as the "was this meant for us?" test for bare commands, so the
 * thresholds are deliberately tight: no Prow / ChatOps command in common use
 * (`/lgtm`, `/retest`, `/hold`, `/approve`, `/reopen`, `/retitle`) lands within
 * range of our vocabulary, while ordinary typos do.
 *
 * An exact match returns null — the word is a real command that simply isn't
 * valid on this surface (e.g. `/review` on an issue), and "did you mean
 * /review?" would be nonsense.
 */
export function suggestCommand(name: string): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of COMMAND_NAMES) {
    const d = editDistance(lower, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  if (bestDistance === 0) return null;
  const threshold = lower.length <= 4 ? 1 : lower.length <= 8 ? 2 : 3;
  return bestDistance <= threshold ? best : null;
}

/**
 * Reply for a slash command we don't recognize.
 *
 * Sent for any namespaced `/<bot> <command>`, and for a bare `/<command>` only
 * when it is close enough to our vocabulary to be a typo rather than another
 * bot's traffic.
 *
 * The reply answers in whichever form the user typed. Suggesting `/review` to
 * someone who wrote `/diffsentry reveiw` would be wrong on a repo with
 * SLASH_COMMANDS_BARE=false: the bare form we advertised is one this bot then
 * ignores, leaving them stuck with no working spelling.
 */
export function formatUnknownCommandMessage(
  botName: string,
  name: string,
  syntax: SlashSyntax = "slash-bare"
): string {
  const prefix = syntax === "slash-namespaced" ? `/${botName} ` : "/";
  const suggestion = suggestCommand(name);
  const hint = suggestion
    ? `Did you mean \`${prefix}${suggestion}${COMMAND_ARGS[suggestion] ?? ""}\`?`
    : `Run \`${prefix}help\` for the full list.`;
  return `> [!NOTE]\n> Unknown command \`${prefix}${name}\`. ${hint}`;
}

/**
 * Return a markdown help message listing all available commands.
 */
export function formatHelpMessage(botName: string): string {
  return `## DiffSentry Commands

Start a comment with a slash command. \`/${botName} <command>\` always works; the
short form is a convenience that other bots on this repo may also claim.

| Command | Description |
|---------|-------------|
| \`/review\` | Trigger an incremental review |
| \`/full-review\` | Trigger a full review of all files |
| \`/pause\` | Pause automatic reviews on this PR |
| \`/resume\` | Resume automatic reviews on this PR |
| \`/resolve\` | Resolve all review comment threads |
| \`/summary\` | Regenerate the PR summary |
| \`/configuration\` | Show active configuration |
| \`/help\` | Show this help message |
| \`/learn <text>\` | Save a learning for future reviews |
| \`/generate-docstrings\` | Add missing docstrings and commit to branch |
| \`/generate-tests\` | Generate unit tests and commit to branch |
| \`/simplify\` | Simplify changed code and commit to branch |
| \`/autofix\` | Apply fixes from review comments and commit to branch |
| \`/tldr\` | One-paragraph TL;DR of the PR |
| \`/tour\` | Suggested reading order with reasoning per file |
| \`/ship\` | Pre-flight verdict — is this PR ready to merge? |
| \`/rubber-duck\` | Socratic questions to challenge the design |
| \`/5why <target>\` | Recursive 5-whys analysis of a behavior or decision |
| \`/eli5\` | Explain the PR like the reviewer is 5 (great for cross-team review) |
| \`/timeline\` | Chronological event timeline for this PR |
| \`/bench\` | Generate a micro-benchmark for the most performance-sensitive change |
| \`/changelog\` | Keep-a-Changelog format entry for this PR |
| \`/release-notes\` | User-facing release notes for this PR |
| \`/diff <PR-number>\` | Compare this PR with another for file overlap |
| \`/rewrite\` | AI-suggested replacement for the PR title + description |

**To ask a question**, mention \`@${botName}\` instead — anything after the mention
that isn't a command is answered as a question about this PR. Every command
above also works as \`@${botName} <command>\`.`;
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
