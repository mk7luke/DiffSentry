import type { Octokit } from "@octokit/rest";
import { logger } from "./logger.js";

export type ReviewerCandidate = {
  login: string;
  changedLinesAuthored: number;
  filesAuthored: number;
};

/**
 * For each changed file, query the GitHub blame API and tally how many
 * lines on the changed-line set each contributor authored. Returns the top
 * N contributors (excluding the PR author, bots, and DiffSentry itself)
 * suitable for "Suggested Reviewers" surface and for auto-assignment.
 */
export async function suggestReviewersFromBlame(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseSha: string;
  files: Array<{ filename: string; patch: string }>;
  excludeLogins?: string[];
  topN?: number;
}): Promise<ReviewerCandidate[]> {
  const exclude = new Set(
    (opts.excludeLogins ?? []).filter(Boolean).map((s) => s.toLowerCase()),
  );
  const tally = new Map<string, { lines: number; files: Set<string> }>();

  for (const f of opts.files) {
    const changedRightLines = parseChangedLeftLines(f.patch);
    if (changedRightLines.size === 0) continue;
    let blameRanges: BlameRange[];
    try {
      blameRanges = await fetchBlameRanges(opts.octokit, {
        owner: opts.owner,
        repo: opts.repo,
        ref: opts.baseSha,
        path: f.filename,
      });
    } catch (err) {
      logger.debug({ err, file: f.filename }, "Blame query failed (file may be new)");
      continue;
    }
    for (const line of changedRightLines) {
      const owner = ownerForLine(blameRanges, line);
      if (!owner) continue;
      const lower = owner.toLowerCase();
      if (exclude.has(lower)) continue;
      if (lower.endsWith("[bot]")) continue;
      const cur = tally.get(owner) ?? { lines: 0, files: new Set<string>() };
      cur.lines += 1;
      cur.files.add(f.filename);
      tally.set(owner, cur);
    }
  }

  return Array.from(tally.entries())
    .map(([login, v]) => ({
      login,
      changedLinesAuthored: v.lines,
      filesAuthored: v.files.size,
    }))
    .sort((a, b) => b.changedLinesAuthored - a.changedLinesAuthored)
    .slice(0, opts.topN ?? 3);
}

type BlameRange = {
  startingLine: number;
  endingLine: number;
  authorLogin: string | null;
};

async function fetchBlameRanges(
  octokit: Octokit,
  opts: { owner: string; repo: string; ref: string; path: string },
): Promise<BlameRange[]> {
  const query = `
    query($owner: String!, $repo: String!, $ref: String!, $path: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $ref) {
          ... on Commit {
            blame(path: $path) {
              ranges {
                startingLine
                endingLine
                commit {
                  author {
                    user { login }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const result: any = await octokit.graphql(query, opts);
  const ranges = result?.repository?.object?.blame?.ranges ?? [];
  return ranges.map((r: any) => ({
    startingLine: r.startingLine,
    endingLine: r.endingLine,
    authorLogin: r.commit?.author?.user?.login ?? null,
  }));
}

function ownerForLine(ranges: BlameRange[], line: number): string | null {
  for (const r of ranges) {
    if (line >= r.startingLine && line <= r.endingLine) return r.authorLogin;
  }
  return null;
}

/**
 * Parse a unified diff and return the set of LEFT-side line numbers that
 * the patch removed/replaced (i.e., the lines we care about for blame on
 * the base ref).
 */
function parseChangedLeftLines(patch: string): Set<number> {
  const out = new Set<number>();
  if (!patch) return out;
  let leftLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
    if (hunk) {
      leftLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) {
      out.add(leftLine);
      leftLine++;
    } else if (line.startsWith("+")) {
      // added lines have no left-side blame source — skip
    } else {
      leftLine++;
    }
  }
  return out;
}

export function renderSuggestedReviewers(reviewers: ReviewerCandidate[]): string {
  if (reviewers.length === 0) return "";
  const bullets = reviewers
    .map(
      (r) =>
        `- @${r.login} — authored ${r.changedLinesAuthored} touched line(s) across ${r.filesAuthored} file(s)`,
    )
    .join("\n");
  return `## Suggested Reviewers\n\nBased on \`git blame\` of the lines this PR modifies:\n\n${bullets}`;
}

/**
 * Combine blame-derived reviewers with CODEOWNERS matches into a single
 * ranked list with per-row source tags. Score = blame lines + 5 * owned
 * files (CODEOWNERS rows weighted because they're explicit ownership).
 */
export type CombinedReviewerRow = {
  login: string;
  blameLines: number;
  blameFiles: number;
  ownedFiles: number;
  isTeam: boolean;
  sources: Array<"blame" | "owner">;
};

export function combineReviewers(
  blame: ReviewerCandidate[],
  owners: Array<{ login: string; filesOwned: number; teams: boolean }>,
  topN = 5,
): CombinedReviewerRow[] {
  const merged = new Map<string, CombinedReviewerRow>();
  for (const b of blame) {
    merged.set(b.login, {
      login: b.login,
      blameLines: b.changedLinesAuthored,
      blameFiles: b.filesAuthored,
      ownedFiles: 0,
      isTeam: false,
      sources: ["blame"],
    });
  }
  for (const o of owners) {
    const cur = merged.get(o.login);
    if (cur) {
      cur.ownedFiles = o.filesOwned;
      cur.isTeam = o.teams;
      if (!cur.sources.includes("owner")) cur.sources.push("owner");
    } else {
      merged.set(o.login, {
        login: o.login,
        blameLines: 0,
        blameFiles: 0,
        ownedFiles: o.filesOwned,
        isTeam: o.teams,
        sources: ["owner"],
      });
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.blameLines + 5 * b.ownedFiles - (a.blameLines + 5 * a.ownedFiles))
    .slice(0, topN);
}

export function renderCombinedReviewers(rows: CombinedReviewerRow[]): string {
  if (rows.length === 0) return "";
  const bullets = rows
    .map((r) => {
      const tags = r.sources.map((s) => `\`${s}\``).join(" + ");
      const teamSuffix = r.isTeam ? " (team)" : "";
      const detailParts: string[] = [];
      if (r.blameLines > 0) detailParts.push(`${r.blameLines} touched line(s)`);
      if (r.ownedFiles > 0) detailParts.push(`owns ${r.ownedFiles} file(s)`);
      return `- @${r.login}${teamSuffix} — ${tags}${detailParts.length ? ` — ${detailParts.join(", ")}` : ""}`;
    })
    .join("\n");
  return `## 👤 Suggested Reviewers\n\nRanked by \`git blame\` weight on the touched lines + CODEOWNERS overlap.\n\n${bullets}`;
}
