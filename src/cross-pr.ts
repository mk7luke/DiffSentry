import type { Octokit } from "@octokit/rest";
import { logger } from "./logger.js";

export type PriorThread = {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  state: string;
  body: string;
  path: string;
  line: number | null;
};

/**
 * For each (path, line) the current PR is commenting on, find prior bot
 * inline comments on the SAME path and similar line ranges in merged
 * PRs. Returns at most maxPerPath entries per location.
 */
export async function findPriorBotThreadsForPaths(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  currentPrNumber: number;
  paths: string[];
  botLogin: string;
  maxPerPath?: number;
  scanLastN?: number;
}): Promise<Map<string, PriorThread[]>> {
  const out = new Map<string, PriorThread[]>();
  const max = opts.maxPerPath ?? 3;
  const scan = opts.scanLastN ?? 25;
  const pathSet = new Set(opts.paths);

  let prs: Awaited<ReturnType<typeof opts.octokit.pulls.list>>["data"] = [];
  try {
    const res = await opts.octokit.pulls.list({
      owner: opts.owner,
      repo: opts.repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: scan,
    });
    prs = res.data;
  } catch (err) {
    logger.debug({ err }, "cross-pr: failed to list closed PRs");
    return out;
  }

  for (const pr of prs) {
    if (pr.number === opts.currentPrNumber) continue;
    if (!pr.merged_at) continue; // only merged PRs are useful as memory

    let comments: Awaited<ReturnType<typeof opts.octokit.pulls.listReviewComments>>["data"] = [];
    try {
      const r = await opts.octokit.pulls.listReviewComments({
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr.number,
        per_page: 100,
      });
      comments = r.data;
    } catch {
      continue;
    }

    for (const c of comments) {
      if (c.user?.login?.toLowerCase() !== opts.botLogin.toLowerCase()) continue;
      if (!c.path || !pathSet.has(c.path)) continue;
      const arr = out.get(c.path) ?? [];
      if (arr.length >= max) continue;
      arr.push({
        prNumber: pr.number,
        prUrl: pr.html_url,
        prTitle: pr.title,
        state: pr.state,
        body: c.body ?? "",
        path: c.path,
        line: c.line ?? c.original_line ?? null,
      });
      out.set(c.path, arr);
    }
  }

  return out;
}

/**
 * Render a small "Prior discussions" footer for an inline comment when at
 * least one matching prior thread exists at the same (path, near-line).
 */
export function renderPriorDiscussionsBlock(
  path: string,
  line: number,
  priorByPath: Map<string, PriorThread[]>,
  windowLines = 30,
): string {
  const priors = (priorByPath.get(path) ?? []).filter((p) => {
    if (p.line == null) return true;
    return Math.abs(p.line - line) <= windowLines;
  });
  if (priors.length === 0) return "";
  const bullets = priors
    .slice(0, 3)
    .map((p) => {
      const oneLine = p.body.split("\n")[0].slice(0, 100).replace(/\|/g, "\\|");
      return `- [#${p.prNumber}](${p.prUrl}) (${p.path}:${p.line ?? "?"}): _${oneLine}_`;
    })
    .join("\n");
  return `\n\n<details>\n<summary>🧠 Prior discussions on this file</summary>\n\n${bullets}\n\n</details>`;
}

// ─── @bot diff <PR-number> support ──────────────────────────────

export async function diffWithOtherPR(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  thisPrNumber: number;
  otherPrNumber: number;
}): Promise<{
  otherTitle: string;
  otherUrl: string;
  thisFiles: string[];
  otherFiles: string[];
  overlap: string[];
}> {
  const [other, thisFilesResp, otherFilesResp] = await Promise.all([
    opts.octokit.pulls.get({ owner: opts.owner, repo: opts.repo, pull_number: opts.otherPrNumber }),
    opts.octokit.paginate(opts.octokit.pulls.listFiles, {
      owner: opts.owner,
      repo: opts.repo,
      pull_number: opts.thisPrNumber,
      per_page: 100,
    }),
    opts.octokit.paginate(opts.octokit.pulls.listFiles, {
      owner: opts.owner,
      repo: opts.repo,
      pull_number: opts.otherPrNumber,
      per_page: 100,
    }),
  ]);
  const thisSet = new Set(thisFilesResp.map((f: any) => f.filename));
  const otherSet = new Set(otherFilesResp.map((f: any) => f.filename));
  const overlap = Array.from(thisSet).filter((f) => otherSet.has(f));
  return {
    otherTitle: other.data.title,
    otherUrl: other.data.html_url,
    thisFiles: Array.from(thisSet) as string[],
    otherFiles: Array.from(otherSet) as string[],
    overlap,
  };
}

export function renderDiffPRReply(
  thisNumber: number,
  result: Awaited<ReturnType<typeof diffWithOtherPR>>,
  botName: string,
): string {
  const lines: string[] = [];
  lines.push(`# 🔀 Diff vs #${thisNumber} (this PR)`);
  lines.push("");
  lines.push(`Comparing against [#${result.otherTitle ? "" : ""}${result.otherTitle}](${result.otherUrl}).`);
  lines.push("");
  lines.push(
    `| | This PR | Other PR | Overlap |`,
  );
  lines.push(`|---|---|---|---|`);
  lines.push(
    `| Files | ${result.thisFiles.length} | ${result.otherFiles.length} | **${result.overlap.length}** |`,
  );
  lines.push("");
  if (result.overlap.length === 0) {
    lines.push("✅ No file overlap — these PRs touch disjoint areas.");
  } else {
    lines.push("⚠️ **Overlapping files** — both PRs modify these. Watch for merge conflicts and racy intent.");
    lines.push("");
    for (const f of result.overlap.slice(0, 30)) lines.push(`- \`${f}\``);
    if (result.overlap.length > 30) lines.push(`- _…and ${result.overlap.length - 30} more_`);
  }
  lines.push("");
  lines.push(`<sub>Re-run with \`@${botName} diff <PR-number>\`.</sub>`);
  return lines.join("\n");
}
