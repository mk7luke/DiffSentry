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

export type Candidate = {
  repo: string;
  number: number;
  title: string;
  language: string | null;
  updatedAt: string;
};

/**
 * Pick candidates for breadth. Walks the list in rounds: each round takes at
 * most one PR per repo, preferring a language not yet represented. Repos stop
 * contributing once they hit maxPerRepo. The April corpus's flaw was 28
 * reviews from one repo, so spread is the selection criterion, not recency.
 */
export function selectForSpread(cands: Candidate[], opts: { limit: number; maxPerRepo: number }): Candidate[] {
  const picked: Candidate[] = [];
  const perRepo = new Map<string, number>();
  const seenLangs = new Set<string>();
  const pool = [...cands];

  while (picked.length < opts.limit) {
    const roundRepos = new Set<string>();
    let progressed = false;

    // Freshness is re-checked at every pick, not pre-sorted once per round:
    // picking a TS repo must make the next TS repo stale *within* this round,
    // or a single popular language crowds the corpus out.
    while (picked.length < opts.limit) {
      const eligible = pool.filter(
        (c) => !roundRepos.has(c.repo) && (perRepo.get(c.repo) ?? 0) < opts.maxPerRepo,
      );
      if (eligible.length === 0) break;

      const c = eligible.find((x) => x.language && !seenLangs.has(x.language)) ?? eligible[0];
      picked.push(c);
      roundRepos.add(c.repo);
      perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
      if (c.language) seenLangs.add(c.language);
      pool.splice(pool.indexOf(c), 1);
      progressed = true;
    }

    if (!progressed) break;
  }

  return picked;
}

/**
 * Redact anything token-shaped before captured text is committed. Scraped
 * public comments sometimes quote a credential a contributor pasted; writing
 * that into this repo would republish it. Deliberately broad — a false
 * redaction costs one sample, a miss costs a leak.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function renderCorpusMarkdown(title: string, comments: CapturedComment[]): string {
  const lines: string[] = [`# ${title}`, ""];
  if (comments.length === 0) {
    lines.push("_No comments captured._", "");
    return lines.join("\n");
  }
  for (const c of comments) {
    const where = c.path ? `${c.path}:${c.line ?? "?"}` : "—";
    lines.push(
      `## ${c.author} · ${classifySurface(c)} · ${c.createdAt}`,
      "",
      `- Source: ${c.url}`,
      `- Location: ${where}`,
      "",
      "```markdown",
      scrubSecrets(c.body),
      "```",
      "",
      "---",
      "",
    );
  }
  return lines.join("\n");
}
