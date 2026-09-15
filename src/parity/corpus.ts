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

/**
 * A login is botty if it carries the `[bot]` suffix GitHub appends to Apps.
 * This only detects REST-style logins. This repo has been bitten before by
 * REST reporting `diffsentry[bot]` while GraphQL reports `diffsentry` with
 * no suffix — fed a GraphQL-sourced login, every comment here would
 * silently classify as `other`.
 */
export function isBotAuthor(login: string): boolean {
  return login.toLowerCase().endsWith("[bot]");
}

export function classifySurface(c: CapturedComment): Surface {
  if (!isBotAuthor(c.author)) return "other";
  // `kind` already tells us the surface for two of the three fetch
  // endpoints — no body inspection needed, and body inspection is actively
  // wrong here. A `pulls/comments` row is an inline comment by construction.
  // A `pulls/reviews` row IS a review summary by construction: its opening
  // text varies with the review's outcome (an "Actionable comments posted"
  // wrapper, a bare "🧹 Nitpick comments" block, a "[!CAUTION] ... outside
  // the diff" callout, a "[!NOTE] Quiet mode is enabled" callout are all
  // real observed openings), so matching on prose misses whichever shape
  // wasn't anticipated. Only `issues/comments` rows are ambiguous enough to
  // need body heuristics — that endpoint carries walkthroughs, status
  // comments, and chat replies alike.
  if (c.kind === "inline") return "inline";
  if (c.kind === "review") return "review-summary";

  const body = c.body;
  // Precedence matters here, not just matching: both bots edit their
  // in-progress "review status" comment in place as the review completes,
  // so a finished walkthrough can still carry the status marker it was born
  // with. Check the terminal shape (walkthrough) before falling back to
  // status, or a completed review gets miscounted as still "in progress".
  // Don't reorder this without re-reading that behaviour.
  if (/^#{1,3}\s*Walkthrough\s*$/im.test(body)) return "walkthrough";
  // Bot-agnostic: matches an HTML comment ending in "status" (DiffSentry's
  // "<!-- DiffSentry Status -->" / "<!-- ... Sticky Status -->") or
  // containing "review status" (both bots' "<!-- ... for review status -->"
  // boilerplate) rather than hardcoding either bot's exact wording.
  if (/<!--[^>]*(?:review[ -]status|status\s*-->)/i.test(body)) return "status";
  // Residual bucket: "none of the above matched", not "verified to be a
  // chat reply". It also catches service notices (rate-limit, draft-skip,
  // skip-review) and, for DiffSentry, every auto-generated release note.
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

/**
 * Longest run of consecutive backticks anywhere in `s`, or 0 if none. Used
 * to size a fence that can safely wrap the text (CommonMark: a fence must
 * be longer than any backtick run it encloses, or the enclosed text can
 * itself be read as a closing fence).
 */
function longestBacktickRun(s: string): number {
  let max = 0;
  for (const run of s.match(/`+/g) ?? []) {
    if (run.length > max) max = run.length;
  }
  return max;
}

export function renderCorpusMarkdown(title: string, comments: CapturedComment[]): string {
  const lines: string[] = [`# ${title}`, ""];
  if (comments.length === 0) {
    lines.push("_No comments captured._", "");
    return lines.join("\n");
  }
  for (const c of comments) {
    const where = c.path ? `${c.path}:${c.line ?? "?"}` : "—";
    const body = scrubSecrets(c.body);
    // Bodies routinely contain their own fenced blocks (CodeRabbit's
    // "Prompt for AI Agents" blocks, nested diff fences in "Analysis
    // chain" sections). A fixed ``` delimiter would be ambiguous — the
    // fence must outrun the longest backtick run already inside the body,
    // per CommonMark's rule for nesting fenced code.
    const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
    lines.push(
      `## ${c.author} · ${classifySurface(c)} · ${c.kind} · ${c.createdAt}`,
      "",
      `- Source: ${c.url}`,
      `- Location: ${where}`,
      "",
      `${fence}markdown`,
      body,
      fence,
      "",
      "---",
      "",
    );
  }
  return lines.join("\n");
}

const EMPTY_MARKER = "_No comments captured._";
// Matches a rendered entry header: "## <author> · <surface> · <kind> · <createdAt>".
// `surface` is dropped on parse — it's derived from `kind` (+ body) by
// classifySurface, and re-deriving it is the entire point of --from-md:
// baking today's surface into stored data would defeat re-bucketing after
// a classifier change.
const HEADER_RE = /^## (.*?) · (.*?) · (issue|review|inline) · (.*)$/;

/**
 * Inverse of renderCorpusMarkdown. Pure, no IO. Recovers every field a
 * CapturedComment needs to be re-classified and re-bucketed, including
 * `kind` (read from the header, not inferred from `surface`).
 */
export function parseCorpusMarkdown(text: string): CapturedComment[] {
  const lines = text.split("\n");
  const comments: CapturedComment[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("## ")) {
    if (lines[i].trim() === EMPTY_MARKER) return [];
    i++;
  }

  while (i < lines.length) {
    const header = HEADER_RE.exec(lines[i]);
    if (!header) throw new Error(`parseCorpusMarkdown: malformed entry header: ${JSON.stringify(lines[i])}`);
    const [, author, , kind, createdAt] = header;
    i++; // consume header
    i++; // blank line

    const sourceLine = lines[i++];
    const url = sourceLine.replace(/^- Source: /, "");
    const locationLine = lines[i++];
    const location = locationLine.replace(/^- Location: /, "");
    let path: string | undefined;
    let line: number | undefined;
    if (location !== "—") {
      const idx = location.lastIndexOf(":");
      path = location.slice(0, idx);
      const lineStr = location.slice(idx + 1);
      line = lineStr === "?" ? undefined : Number(lineStr);
    }

    i++; // blank line
    const fenceOpen = lines[i++];
    const fenceMatch = /^(`{3,})markdown$/.exec(fenceOpen);
    if (!fenceMatch) throw new Error(`parseCorpusMarkdown: expected a fenced code block, got: ${JSON.stringify(fenceOpen)}`);
    const closeFence = fenceMatch[1];

    const bodyLines: string[] = [];
    while (lines[i] !== closeFence) {
      if (i >= lines.length) throw new Error("parseCorpusMarkdown: unterminated fenced code block");
      bodyLines.push(lines[i]);
      i++;
    }
    i++; // consume closing fence
    const body = bodyLines.join("\n");

    i++; // blank line
    i++; // "---"
    i++; // blank line

    comments.push({ kind: kind as CapturedComment["kind"], body, author, path, line, createdAt, url });
  }

  return comments;
}
