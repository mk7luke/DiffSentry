/**
 * Slash-command extraction for PR / issue comment bodies.
 *
 * GitHub has no registry for third-party slash commands — the `/` menu in the
 * comment composer is a hardcoded set of client-side markdown expanders
 * (`/code`, `/table`, `/details`, …) with no extension point for Apps. So a
 * bot "slash command" is purely a parsing convention over the comment body we
 * already receive on the issue_comment / pull_request_review_comment webhooks,
 * the same approach Prow and probot/commands take.
 *
 * Two addressing forms are supported:
 *   - namespaced: `/diffsentry review`  — unambiguously ours
 *   - bare:       `/review`             — convenient, but shares a namespace
 *                                         with every other bot on the repo
 *
 * The distinction matters for error handling, not routing: an unrecognized
 * namespaced command earns a "did you mean" reply, while an unrecognized bare
 * command is silently ignored so we never answer another bot's `/lgtm`.
 */

/**
 * How a slash command was addressed. Carried through to the unknown-command
 * reply so it can answer in the same form the user typed — telling someone on
 * a bare-disabled repo to "try `/review`" would send them to a command we
 * ignore.
 */
export type SlashSyntax = "slash-namespaced" | "slash-bare";

export interface SlashCommand {
  /** Command text with the leading `/` (and bot namespace) stripped, e.g. "full review". */
  text: string;
  /** The bare command word, used for logging and "unknown command" replies. */
  name: string;
  syntax: SlashSyntax;
}

export interface SlashOptions {
  /** Master switch for slash parsing. Default true. */
  enabled?: boolean;
  /** Accept bare `/review` in addition to `/diffsentry review`. Default true. */
  bare?: boolean;
}

/**
 * GitHub's own composer commands. Typing these opens GitHub's picker rather
 * than sending text, but a user can still post them literally (or paste them),
 * and a bot that answered `/table` would be actively confusing. Never ours.
 */
const GITHUB_RESERVED = new Set([
  "code",
  "details",
  "table",
  "template",
  "alerts",
  "saved-replies",
  "saved-reply",
  "tasklist",
]);

/**
 * Slash spellings for our multi-word commands. `/full-review` reads naturally
 * as a slash command but the shared command matcher expects the spoken form
 * ("full review") that the @mention path produces, so normalize on the way in.
 */
const HYPHENATED_ALIASES: Record<string, string> = {
  "full-review": "full review",
  "generate-docstrings": "generate docstrings",
  "generate-docstring": "generate docstrings",
  "generate-tests": "generate tests",
  "generate-unit-tests": "generate unit tests",
};

/**
 * Strip content where a leading `/` is text rather than an instruction:
 * fenced code blocks, indented code blocks, and quoted replies. Without this,
 * quoting someone else's `/review` — which GitHub does automatically in the
 * "Quote reply" flow — would trigger a second review.
 */
function eligibleLines(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;

  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();

    // Fenced blocks: ``` or ~~~, closed by the same marker.
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    // Quoted reply text.
    if (trimmed.startsWith(">")) continue;

    // Indented code block (4 spaces or a tab), but only when it is not a
    // continuation of a list item — close enough, and errs toward ignoring.
    if (/^(\t| {4})/.test(raw)) continue;

    out.push(trimmed);
  }

  return out;
}

/**
 * Find a slash command addressed to us in a comment body.
 *
 * Returns null when slash parsing is disabled, when no eligible line starts
 * with `/`, when the command is one of GitHub's own, or when the only match is
 * a bare command and bare commands are disabled.
 */
export function extractSlashCommand(
  body: string,
  botName: string,
  opts: SlashOptions = {}
): SlashCommand | null {
  const enabled = opts.enabled !== false;
  const bareAllowed = opts.bare !== false;
  if (!enabled) return null;

  const bot = botName.toLowerCase();

  for (const line of eligibleLines(body)) {
    if (!line.startsWith("/")) continue;

    const afterSlash = line.slice(1);
    const firstWord = afterSlash.split(/\s/)[0].toLowerCase();
    if (!firstWord) continue;

    // Namespaced: `/diffsentry <command>`. Bare `/diffsentry` means help.
    if (firstWord === bot) {
      const rest = afterSlash.slice(firstWord.length).trim();
      const text = normalize(rest || "help");
      return { text, name: text.split(/\s/)[0], syntax: "slash-namespaced" };
    }

    if (GITHUB_RESERVED.has(firstWord)) continue;
    if (!bareAllowed) continue;

    // A path-looking token (`/usr/local/bin`, `/api/v2/foo`) is prose, not a
    // command. Command words never contain a slash.
    if (firstWord.includes("/")) continue;

    const text = normalize(afterSlash.trim());
    return { text, name: text.split(/\s/)[0], syntax: "slash-bare" };
  }

  return null;
}

/** Expand hyphenated slash spellings into the form the command matcher expects. */
function normalize(text: string): string {
  const firstWord = text.split(/\s/)[0].toLowerCase();
  const expanded = HYPHENATED_ALIASES[firstWord];
  if (!expanded) return text;
  return (expanded + text.slice(firstWord.length)).trim();
}

/**
 * Cheap syntactic check for the webhook gate: could this comment be addressed
 * to us at all? Runs before any GitHub API call, so it must stay allocation-
 * light and free of network work.
 */
export function addressesBot(
  body: string,
  botName: string,
  opts: SlashOptions = {}
): boolean {
  if (body.toLowerCase().includes(`@${botName.toLowerCase()}`)) return true;
  return extractSlashCommand(body, botName, opts) !== null;
}
