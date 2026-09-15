# Parity Corpus Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace a five-month-old, single-repo snapshot of CodeRabbit's comment shape with a current, multi-language corpus plus rendered screenshots of both bots, and turn the difference into a dispositioned gap backlog.

**Architecture:** A pure core (`src/parity/corpus.ts`) owns comment classification, PR selection and corpus rendering, with no IO. A thin `scripts/capture-corpus.ts` shell supplies data via the already-authenticated `gh` CLI and writes the corpus to disk. Screenshots are produced by the agent session's Playwright MCP tooling and committed as artifacts — deliberately not a repo dependency. Analysis documents are written against the captured artifacts, never from memory.

**Tech Stack:** TypeScript (CommonJS output, NodeNext-style `.js` import specifiers), vitest, tsx for scripts, `gh` CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-coderabbit-parity-capture-design.md`

## Global Constraints

- **No new dependencies.** Not in `package.json`, not in `web/package.json`. Playwright specifically is excluded — screenshots come from agent MCP tooling.
- **Imports use `.js` specifiers** that resolve to sibling `.ts` sources (`../../src/parity/corpus.js`). This is repo-wide; `vitest.config.ts` has a resolver plugin for it.
- **Unit tests live in `tests/unit/*.test.ts`** and are the only files vitest collects.
- **The April corpus is immutable.** Files directly under `tests/e2e/reference/` are the drift baseline. Add to `tests/e2e/reference/2026-09/`; never edit or move the April files.
- **`CODERABBIT-FORMAT.md` is extended, never replaced.** The brief forbids a second format doc.
- **Every gap carries a disposition** — `adopt`, `adapt-lighter`, or `decline` — with a reason. A gap without one is an incomplete finding.
- **No credentials in captured data.** Scrubbing is enforced in code, not by inspection.

---

### Task 1: Corpus core — surface classification

**Files:**
- Create: `src/parity/corpus.ts`
- Test: `tests/unit/parity-corpus.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Surface = "walkthrough" | "review-summary" | "inline" | "status" | "chat" | "other"`; `classifySurface(c: CapturedComment): Surface`; `type CapturedComment = { kind: "issue" | "review" | "inline"; body: string; author: string; path?: string; line?: number; createdAt: string; url: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classifySurface, type CapturedComment } from "../../src/parity/corpus.js";

function c(over: Partial<CapturedComment>): CapturedComment {
  return { kind: "issue", body: "", author: "coderabbitai[bot]", createdAt: "2026-09-01T00:00:00Z", url: "u", ...over };
}

describe("classifySurface", () => {
  it("identifies a walkthrough by its heading", () => {
    expect(classifySurface(c({ body: "## Walkthrough\n\nThis PR adds..." }))).toBe("walkthrough");
  });

  it("identifies a review summary by the actionable-comments wrapper", () => {
    expect(classifySurface(c({ kind: "review", body: "**Actionable comments posted: 3**" }))).toBe("review-summary");
  });

  it("identifies any inline-kind comment as inline", () => {
    expect(classifySurface(c({ kind: "inline", body: "_:warning: Potential issue_", path: "a.ts", line: 4 }))).toBe("inline");
  });

  it("identifies a status comment by its review-status marker", () => {
    expect(classifySurface(c({ body: "<!-- coderabbit review status -->\nReviewing..." }))).toBe("status");
  });

  it("treats a bot reply that is none of the above as chat", () => {
    expect(classifySurface(c({ body: "@someone Good question — the reason is..." }))).toBe("chat");
  });

  it("classifies a human comment as other", () => {
    expect(classifySurface(c({ body: "lgtm", author: "octocat" }))).toBe("other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: FAIL — cannot resolve `src/parity/corpus.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parity/corpus.ts tests/unit/parity-corpus.test.ts
git commit -m "feat(parity): classify review-bot comments by surface"
```

---

### Task 2: Corpus core — PR selection for spread

**Files:**
- Modify: `src/parity/corpus.ts`
- Modify: `tests/unit/parity-corpus.test.ts`

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `type Candidate = { repo: string; number: number; title: string; language: string | null; updatedAt: string }`; `selectForSpread(cands: Candidate[], opts: { limit: number; maxPerRepo: number }): Candidate[]`.

The point of selection is **spread, not volume** — the April corpus failed by being 28 reviews from one repo. Selection rotates across repositories so no single project dominates, and prefers unseen languages.

- [ ] **Step 1: Write the failing test**

```ts
import { selectForSpread, type Candidate } from "../../src/parity/corpus.js";

function cand(repo: string, number: number, language: string | null): Candidate {
  return { repo, number, title: `pr ${number}`, language, updatedAt: "2026-09-01T00:00:00Z" };
}

describe("selectForSpread", () => {
  it("caps how many PRs any single repo contributes", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("a/a", 2, "TS"), cand("a/a", 3, "TS"), cand("b/b", 4, "Go")],
      { limit: 10, maxPerRepo: 2 },
    );
    expect(out.filter((c) => c.repo === "a/a")).toHaveLength(2);
    expect(out.map((c) => c.repo)).toContain("b/b");
  });

  it("prefers an unseen language over a second PR in a seen one", () => {
    const out = selectForSpread(
      [cand("a/a", 1, "TS"), cand("b/b", 2, "TS"), cand("c/c", 3, "Python")],
      { limit: 2, maxPerRepo: 1 },
    );
    expect(out.map((c) => c.language)).toEqual(["TS", "Python"]);
  });

  it("honours the overall limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(`r${i}/r`, i, `L${i}`));
    expect(selectForSpread(many, { limit: 5, maxPerRepo: 1 })).toHaveLength(5);
  });

  it("returns an empty array for no candidates", () => {
    expect(selectForSpread([], { limit: 5, maxPerRepo: 2 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: FAIL — `selectForSpread is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/parity/corpus.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parity/corpus.ts tests/unit/parity-corpus.test.ts
git commit -m "feat(parity): select corpus PRs for language and repo spread"
```

---

### Task 3: Corpus core — credential scrubbing and rendering

**Files:**
- Modify: `src/parity/corpus.ts`
- Modify: `tests/unit/parity-corpus.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `scrubSecrets(text: string): string`; `renderCorpusMarkdown(title: string, comments: CapturedComment[]): string`.

Scrubbing runs on every captured body before it touches disk. Scraped public comments can quote a token that a contributor pasted; committing that into this repo would republish it.

- [ ] **Step 1: Write the failing test**

```ts
import { scrubSecrets, renderCorpusMarkdown } from "../../src/parity/corpus.js";

describe("scrubSecrets", () => {
  it("redacts a GitHub token", () => {
    expect(scrubSecrets("use ghp_" + "a".repeat(36) + " here")).toBe("use [REDACTED] here");
  });

  it("redacts an AWS access key id", () => {
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
  });

  it("redacts a private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED]");
  });

  it("leaves ordinary prose untouched", () => {
    expect(scrubSecrets("This adds a token bucket rate limiter.")).toBe("This adds a token bucket rate limiter.");
  });
});

describe("renderCorpusMarkdown", () => {
  it("emits one section per comment with provenance and scrubbed body", () => {
    const out = renderCorpusMarkdown("Walkthroughs", [
      { kind: "issue", body: "## Walkthrough\nghp_" + "b".repeat(36), author: "coderabbitai[bot]", createdAt: "2026-09-01T00:00:00Z", url: "https://x/1" },
    ]);
    expect(out).toContain("# Walkthroughs");
    expect(out).toContain("https://x/1");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghp_");
  });

  it("says so explicitly when nothing was captured", () => {
    expect(renderCorpusMarkdown("Empty", [])).toContain("_No comments captured._");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: FAIL — `scrubSecrets is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/parity/corpus.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/parity-corpus.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/parity/corpus.ts tests/unit/parity-corpus.test.ts
git commit -m "feat(parity): scrub credentials and render captured corpora"
```

---

### Task 4: Capture script

**Files:**
- Create: `scripts/capture-corpus.ts`
- Modify: `package.json` (scripts section only)

**Interfaces:**
- Consumes: every export from `src/parity/corpus.ts`.
- Produces: a CLI — `npx tsx scripts/capture-corpus.ts --bot <login> --out <dir> [--limit N] [--repo owner/name]`.

This is the IO shell: it shells out to the already-authenticated `gh` CLI (verified working as `mk7luke`) and writes files. All judgment lives in Task 1–3's pure functions, so this file stays thin and needs no unit test of its own.

- [ ] **Step 1: Write the script**

```ts
/**
 * Capture a review bot's comment corpus from public PRs into dated reference
 * files. Judgment (classification, selection, scrubbing) lives in
 * src/parity/corpus.ts and is unit-tested; this shell only does IO.
 *
 *   npx tsx scripts/capture-corpus.ts --bot "coderabbitai[bot]" --out tests/e2e/reference/2026-09/coderabbit
 *   npx tsx scripts/capture-corpus.ts --bot "diffsentry[bot]" --repo mk7luke/DiffSentry --out tests/e2e/reference/2026-09/diffsentry
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  classifySurface,
  selectForSpread,
  renderCorpusMarkdown,
  scrubSecrets,
  type CapturedComment,
  type Candidate,
  type Surface,
} from "../src/parity/corpus.js";

function gh(args: string[]): unknown {
  const raw = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return raw.trim() ? JSON.parse(raw) : null;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function findCandidates(bot: string, limit: number, repo: string | null): Candidate[] {
  const search = [
    "search", "issues", "--commenter", bot, "--include-prs", "--sort", "updated",
    "--limit", String(limit * 4), "--json", "repository,number,title,updatedAt",
  ];
  if (repo) search.push("--repo", repo);
  else search.push("--visibility", "public", "--updated", ">2026-08-01");

  const rows = (gh(search) ?? []) as Array<{ repository: { nameWithOwner: string }; number: number; title: string; updatedAt: string }>;
  const langCache = new Map<string, string | null>();

  return rows.map((r) => {
    const name = r.repository.nameWithOwner;
    if (!langCache.has(name)) {
      try {
        const meta = gh(["repo", "view", name, "--json", "primaryLanguage"]) as { primaryLanguage: { name: string } | null };
        langCache.set(name, meta?.primaryLanguage?.name ?? null);
      } catch {
        langCache.set(name, null);
      }
    }
    return { repo: name, number: r.number, title: r.title, language: langCache.get(name) ?? null, updatedAt: r.updatedAt };
  });
}

function fetchComments(c: Candidate, bot: string): CapturedComment[] {
  const [owner, name] = c.repo.split("/");
  const out: CapturedComment[] = [];
  const want = bot.toLowerCase();

  const issue = (gh(["api", `repos/${owner}/${name}/issues/${c.number}/comments`, "--paginate"]) ?? []) as Array<{ body: string; user: { login: string }; created_at: string; html_url: string }>;
  for (const x of issue) {
    if (x.user.login.toLowerCase() !== want) continue;
    out.push({ kind: "issue", body: x.body ?? "", author: x.user.login, createdAt: x.created_at, url: x.html_url });
  }

  const reviews = (gh(["api", `repos/${owner}/${name}/pulls/${c.number}/reviews`, "--paginate"]) ?? []) as Array<{ body: string; user: { login: string }; submitted_at: string; html_url: string }>;
  for (const x of reviews) {
    if (x.user?.login?.toLowerCase() !== want || !x.body) continue;
    out.push({ kind: "review", body: x.body, author: x.user.login, createdAt: x.submitted_at, url: x.html_url });
  }

  const inline = (gh(["api", `repos/${owner}/${name}/pulls/${c.number}/comments`, "--paginate"]) ?? []) as Array<{ body: string; user: { login: string }; created_at: string; html_url: string; path: string; line: number | null }>;
  for (const x of inline) {
    if (x.user.login.toLowerCase() !== want) continue;
    out.push({ kind: "inline", body: x.body ?? "", author: x.user.login, createdAt: x.created_at, url: x.html_url, path: x.path, line: x.line ?? undefined });
  }

  return out;
}

function main(): void {
  const bot = arg("bot");
  const outDir = arg("out");
  const limit = Number(arg("limit", "18"));
  const repoFilter = process.argv.includes("--repo") ? arg("repo") : null;

  const selected = selectForSpread(findCandidates(bot, limit, repoFilter), { limit, maxPerRepo: 2 });
  if (selected.length === 0) throw new Error(`no candidate PRs found for ${bot}`);

  const all: CapturedComment[] = [];
  for (const c of selected) {
    process.stderr.write(`capturing ${c.repo}#${c.number} (${c.language ?? "unknown"})\n`);
    all.push(...fetchComments(c, bot));
  }

  const buckets: Record<Surface, CapturedComment[]> = {
    walkthrough: [], "review-summary": [], inline: [], status: [], chat: [], other: [],
  };
  for (const c of all) buckets[classifySurface(c)].push(c);

  fs.mkdirSync(outDir, { recursive: true });
  const titles: Record<string, string> = {
    walkthrough: "Walkthroughs", "review-summary": "Review summaries",
    inline: "Inline comments", status: "Status comments", chat: "Chat replies",
  };
  for (const [surface, title] of Object.entries(titles)) {
    fs.writeFileSync(path.join(outDir, `${surface}.md`), renderCorpusMarkdown(title, buckets[surface as Surface]), "utf8");
  }

  const manifest = {
    bot,
    capturedAt: new Date().toISOString(),
    prs: selected.map((c) => ({ repo: c.repo, number: c.number, language: c.language, url: `https://github.com/${c.repo}/pull/${c.number}` })),
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "raw.json"), scrubSecrets(JSON.stringify(all, null, 2)), "utf8");

  process.stderr.write(`wrote ${all.length} comments from ${selected.length} PRs to ${outDir}\n`);
}

main();
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, after the existing `e2e` entry:

```json
"capture:coderabbit": "tsx scripts/capture-corpus.ts --bot \"coderabbitai[bot]\" --out tests/e2e/reference/2026-09/coderabbit",
"capture:diffsentry": "tsx scripts/capture-corpus.ts --bot \"diffsentry[bot]\" --repo mk7luke/DiffSentry --out tests/e2e/reference/2026-09/diffsentry",
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run build:server`
Expected: exit 0, no diagnostics.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-corpus.ts package.json
git commit -m "feat(parity): add corpus capture script"
```

---

### Task 5: Run the capture

**Files:**
- Create: `tests/e2e/reference/2026-09/coderabbit/*.md`, `manifest.json`, `raw.json`
- Create: `tests/e2e/reference/2026-09/diffsentry/*.md`, `manifest.json`, `raw.json`

- [ ] **Step 1: Capture CodeRabbit**

Run: `npm run capture:coderabbit`
Expected: stderr lists each PR captured; ends with a count over 15 PRs.

- [ ] **Step 2: Capture DiffSentry**

Run: `npm run capture:diffsentry`
Expected: same shape, all PRs from `mk7luke/DiffSentry`.

- [ ] **Step 3: Verify the captures are real**

```bash
jq '.counts' tests/e2e/reference/2026-09/coderabbit/manifest.json
jq '.prs | length, (map(.language) | unique)' tests/e2e/reference/2026-09/coderabbit/manifest.json
# Scoped to the captured corpora. The fixture repo is excluded on purpose: it
# plants AWS's published documentation key, which must survive verbatim.
grep -rciE "ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY" \
  tests/e2e/reference/2026-09/coderabbit tests/e2e/reference/2026-09/diffsentry \
  || echo "no unredacted secrets"
```

Expected: every surface except `other` non-zero; at least four distinct languages; the secret grep reports no hits. If `walkthrough` is zero, selection caught only status-comment PRs — re-run with a higher `--limit`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/reference/2026-09
git commit -m "chore(parity): capture September 2026 corpus for both bots"
```

---

### Task 6: Rendered screenshots

**Files:**
- Create: `tests/e2e/reference/2026-09/screenshots/coderabbit/*.png`
- Create: `tests/e2e/reference/2026-09/screenshots/diffsentry/*.png`
- Create: `tests/e2e/reference/2026-09/screenshots/README.md`

Screenshots record what the API cannot: whether a `<details>` renders collapsed, how severity headers read at a glance, whether a suggestion block gets GitHub's native apply affordance. Capture via the agent session's Playwright MCP tooling against the public PR URLs in each `manifest.json`. No auth, no repo dependency.

- [ ] **Step 1: Capture the CodeRabbit set**

For PR URLs drawn from `tests/e2e/reference/2026-09/coderabbit/manifest.json`, capture at viewport width 1280:

| File | Shows |
|---|---|
| `walkthrough-collapsed.png` | The walkthrough comment as it first renders |
| `walkthrough-expanded.png` | The same comment with its `<details>` opened |
| `review-summary.png` | The "Actionable comments posted" review body |
| `inline-finding.png` | One inline comment, severity header visible |
| `suggestion-block.png` | A committable suggestion with GitHub's apply UI |
| `status-comment.png` | The sticky status/progress comment |

- [ ] **Step 2: Capture the DiffSentry set**

The same six filenames under `screenshots/diffsentry/`, from `mk7luke/DiffSentry` PR URLs in the DiffSentry manifest. Where DiffSentry has no equivalent surface, omit the file — its absence is itself a finding for Task 8.

- [ ] **Step 3: Write the procedure README**

`screenshots/README.md` records, for each PNG: the source PR URL, the capture date, the viewport width, and one line on what the shot is evidence of. Also state why Playwright is not a repo dependency (browser binaries in CI for a capture that runs a few times a year) and how to redo the captures.

- [ ] **Step 4: Verify every shot**

Open each PNG and confirm it shows the surface its filename claims, that text is legible at full size, and that no private repository content or account UI is visible. A shot that does not show its surface is deleted and retaken, not kept.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reference/2026-09/screenshots
git commit -m "chore(parity): capture rendered screenshots of both bots"
```

---

### Task 7: Corpus README

**Files:**
- Create: `tests/e2e/reference/2026-09/README.md`
- Modify: `docs/E2E-DEPLOY-LOOP.md:15` and `:201`

- [ ] **Step 1: Write the README**

State: what was captured and when; that the files directly under `tests/e2e/reference/` are the April 2026 baseline and are deliberately not updated; how to re-run the capture; and that every body passed through `scrubSecrets`.

- [ ] **Step 2: Update the docs that point at the reference directory**

`docs/E2E-DEPLOY-LOOP.md` describes `tests/e2e/reference/` as "a live capture ... on a real PR". Amend both mentions to note the dated subdirectories and which is current.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/reference/2026-09/README.md docs/E2E-DEPLOY-LOOP.md
git commit -m "docs(parity): document the dated reference corpora"
```

---

### Task 8: Drift analysis

**Files:**
- Create: `tests/e2e/reference/2026-09/drift.md`

Two comparisons, argued only from committed artifacts. Every claim cites a file or a PR URL; a claim that cannot cite is cut.

- [ ] **Step 1: Compare April against September (what CodeRabbit changed)**

Read `tests/e2e/reference/coderabbit-*.md` against `2026-09/coderabbit/*.md`. For each of the surfaces in `CODERABBIT-FORMAT.md`, record: unchanged, changed (with before/after quoted), added, or removed.

- [ ] **Step 2: Compare CodeRabbit against DiffSentry, both September**

Same surfaces, `2026-09/coderabbit/` against `2026-09/diffsentry/`, and the screenshot pairs from Task 6. Separate *structural* differences (a section DiffSentry does not emit) from *presentational* ones (same information, different rendering) — they have very different costs to close.

- [ ] **Step 3: State the size of the visual gap**

Answer in the document, plainly: did CodeRabbit's comment shape move materially since April? This determines whether the visual workstream is small or large, and the spec's phase ordering exists to answer it before trial time is spent.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/reference/2026-09/drift.md
git commit -m "docs(parity): analyse comment-shape drift and the current gap"
```

---

### Task 9: Gap backlog and format-rubric refresh

**Files:**
- Create: `docs/parity/gap-backlog.md`
- Modify: `tests/e2e/reference/CODERABBIT-FORMAT.md:142-190`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the backlog**

One row per gap: what CodeRabbit does, what DiffSentry does, the evidence (file or URL), the disposition (`adopt` / `adapt-lighter` / `decline`), and the reason. For `adapt-lighter`, name the lighter mechanism. Seed the `decline` column from the brief's §6 and from any tier-gated capability whose value is a SaaS artifact.

Where observation contradicts the brief's priority ordering, say so explicitly and give the corrected order — the brief was written from the stale corpus.

- [ ] **Step 2: Refresh the rubric's stale section**

`CODERABBIT-FORMAT.md`'s "DiffSentry parity gap (current vs target)" (lines 142–190) was written against the April snapshot. Rewrite it against the September corpus. Do not touch the surface anatomy above line 142 except where Task 8 found an actual change, and do not create a second format document.

- [ ] **Step 3: Update the changelog**

Add under `[Unreleased]`, in the repo's existing style, noting the refreshed corpus, the screenshots, and the backlog.

- [ ] **Step 4: Verify the disposition rule holds**

```bash
grep -c "adopt\|adapt-lighter\|decline" docs/parity/gap-backlog.md
```

Read the table and confirm every row has exactly one disposition and a non-empty reason. A row without one fails this task.

- [ ] **Step 5: Commit**

```bash
git add docs/parity/gap-backlog.md tests/e2e/reference/CODERABBIT-FORMAT.md CHANGELOG.md
git commit -m "docs(parity): classify every gap adopt/adapt-lighter/decline"
```

---

### Task 10: Full verification

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 2: Typecheck**

Run: `npm run build:server`
Expected: exit 0.

- [ ] **Step 3: Tests, compared against main**

```bash
npx vitest run 2>&1 | tail -5
git stash list  # confirm nothing of ours is stashed
```

Expected: all pass. Compare the total test count against `main`'s — a count that dropped means a file stopped being collected. Per this repo's history, reading the number in isolation proves nothing.

- [ ] **Step 4: Confirm the April baseline is untouched**

```bash
git diff --name-only main... -- tests/e2e/reference/ | grep -v "^tests/e2e/reference/2026-09/" | grep -v CODERABBIT-FORMAT
```

Expected: no output. Any April file appearing here violates a global constraint.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix(parity): address verification findings"
```
