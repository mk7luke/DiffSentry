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
