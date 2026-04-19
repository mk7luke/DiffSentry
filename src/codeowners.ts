import type { Octokit } from "@octokit/rest";
import { minimatch } from "minimatch";
import { logger } from "./logger.js";

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

export type OwnerRule = {
  pattern: string;
  owners: string[];
};

/**
 * Parse a CODEOWNERS file body into ordered rules. Lines starting with `#`
 * are comments. Each non-empty line is a glob followed by one or more
 * @owners (users or teams). Rules are returned in source order — last
 * matching rule wins, per GitHub semantics.
 */
export function parseCodeowners(body: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const pattern = tokens[0];
    const owners = tokens.slice(1).filter((t) => t.startsWith("@")).map((t) => t.slice(1));
    if (owners.length > 0) rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * For a given file path, return the matching owners (last rule wins). A
 * rule pattern that starts with '/' anchors at repo root; otherwise it
 * matches anywhere. Trailing '/' implies '/**'.
 */
export function ownersForPath(rules: OwnerRule[], filePath: string): string[] {
  let matched: string[] = [];
  for (const r of rules) {
    let pat = r.pattern;
    if (pat.endsWith("/")) pat = pat + "**";
    if (pat.startsWith("/")) pat = pat.slice(1);
    else pat = `**/${pat}`;
    if (minimatch(filePath, pat, { dot: true })) {
      matched = r.owners;
    }
  }
  return matched;
}

export async function loadCodeowners(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<OwnerRule[]> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data) || data.type !== "file" || !data.content) continue;
      const body = Buffer.from(data.content, "base64").toString("utf-8");
      logger.debug({ owner, repo, path }, "Loaded CODEOWNERS");
      return parseCodeowners(body);
    } catch (err: any) {
      if (err.status !== 404) logger.debug({ err, path }, "CODEOWNERS load error");
    }
  }
  return [];
}

/**
 * Aggregate codeowners across the changed files. Returns each owner with
 * the count of files they own.
 */
export function ownersForFiles(
  rules: OwnerRule[],
  files: string[],
  exclude: string[] = [],
): Array<{ login: string; filesOwned: number; teams: boolean }> {
  if (rules.length === 0) return [];
  const excludeLc = new Set(exclude.map((s) => s.toLowerCase()));
  const tally = new Map<string, { filesOwned: number; teams: boolean }>();
  for (const f of files) {
    const owners = ownersForPath(rules, f);
    for (const o of owners) {
      if (excludeLc.has(o.toLowerCase())) continue;
      const isTeam = o.includes("/"); // org/team format
      const cur = tally.get(o) ?? { filesOwned: 0, teams: isTeam };
      cur.filesOwned += 1;
      tally.set(o, cur);
    }
  }
  return Array.from(tally.entries())
    .map(([login, v]) => ({ login, filesOwned: v.filesOwned, teams: v.teams }))
    .sort((a, b) => b.filesOwned - a.filesOwned);
}

export function renderCodeownersBlock(
  owners: Array<{ login: string; filesOwned: number; teams: boolean }>,
): string {
  if (owners.length === 0) return "";
  const bullets = owners
    .slice(0, 5)
    .map((o) => `- @${o.login}${o.teams ? " (team)" : ""} — owns ${o.filesOwned} touched file(s)`)
    .join("\n");
  return `## 👥 CODEOWNERS\n\nMatching owners for the files this PR touches:\n\n${bullets}\n\n<sub>From the repo's \`CODEOWNERS\` file. \`@bot ship\` will also factor these in (future).</sub>`;
}
