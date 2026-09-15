/**
 * Pure helpers for capturing a review bot's comment corpus. No IO: the shell
 * in scripts/capture-corpus.ts supplies data and writes results, so every rule
 * here is unit-testable against a literal.
 */
export type Surface = "walkthrough" | "review-summary" | "inline" | "status" | "chat" | "other";

export type CapturedComment = {
  kind: "issue" | "review" | "inline";
  body: string;
  author: string;
  path?: string;
  line?: number;
  createdAt: string;
  url: string;
};

/** A login is botty if it carries the `[bot]` suffix GitHub appends to Apps. */
export function isBotAuthor(login: string): boolean {
  return login.toLowerCase().endsWith("[bot]");
}

export function classifySurface(c: CapturedComment): Surface {
  if (!isBotAuthor(c.author)) return "other";
  if (c.kind === "inline") return "inline";

  const body = c.body;
  if (/<!--\s*\w+[ -]review[ -]status\s*-->/i.test(body)) return "status";
  if (/^#{1,3}\s*Walkthrough\s*$/im.test(body)) return "walkthrough";
  if (/\*\*Actionable comments posted:\s*\d+\*\*/i.test(body)) return "review-summary";
  return "chat";
}
