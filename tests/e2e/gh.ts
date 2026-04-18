import { shx } from "./sh.js";
import type {
  CapturedInlineComment,
  CapturedIssueComment,
  CapturedReview,
  CapturedStatus,
} from "./types.js";

export const SANDBOX_REPO = process.env.SANDBOX_REPO ?? "mk7luke/diffsentry-sandbox";
export const BOT_LOGIN = process.env.BOT_LOGIN ?? "diffsentry[bot]";

async function ghJson<T = unknown>(pathSuffix: string): Promise<T> {
  const out = await shx("gh", ["api", pathSuffix, "--paginate"]);
  // --paginate concatenates JSON arrays back-to-back as `][`. Repair to a single array.
  const repaired = out.replace(/]\s*\[/g, ",");
  return JSON.parse(repaired) as T;
}

export async function openPR(opts: {
  head: string;
  base?: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ number: number; url: string }> {
  const args = [
    "pr",
    "create",
    "--repo",
    SANDBOX_REPO,
    "--head",
    opts.head,
    "--base",
    opts.base ?? "main",
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
  if (opts.draft) args.push("--draft");
  const url = (await shx("gh", args)).trim();
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Could not parse PR number from: ${url}`);
  return { number: Number(m[1]), url };
}

export async function postIssueComment(prNumber: number, body: string): Promise<void> {
  await shx("gh", [
    "pr",
    "comment",
    String(prNumber),
    "--repo",
    SANDBOX_REPO,
    "--body",
    body,
  ]);
}

export async function getReviews(prNumber: number): Promise<CapturedReview[]> {
  const data = await ghJson<Array<any>>(`repos/${SANDBOX_REPO}/pulls/${prNumber}/reviews`);
  return data.map((r) => ({
    user: r.user?.login ?? "",
    state: r.state ?? "",
    body: r.body ?? null,
    submitted_at: r.submitted_at ?? null,
  }));
}

export async function getInlineComments(prNumber: number): Promise<CapturedInlineComment[]> {
  const data = await ghJson<Array<any>>(`repos/${SANDBOX_REPO}/pulls/${prNumber}/comments`);
  return data.map((c) => ({
    user: c.user?.login ?? "",
    path: c.path ?? "",
    line: c.line ?? c.original_line ?? null,
    body: c.body ?? "",
    created_at: c.created_at ?? "",
  }));
}

export async function getIssueComments(prNumber: number): Promise<CapturedIssueComment[]> {
  const data = await ghJson<Array<any>>(`repos/${SANDBOX_REPO}/issues/${prNumber}/comments`);
  return data.map((c) => ({
    user: c.user?.login ?? "",
    body: c.body ?? "",
    created_at: c.created_at ?? "",
  }));
}

export async function getStatusForBranch(branch: string): Promise<CapturedStatus[]> {
  try {
    const data = await ghJson<{ statuses?: Array<any> }>(
      `repos/${SANDBOX_REPO}/commits/${encodeURIComponent(branch)}/status`,
    );
    return (data.statuses ?? []).map((s) => ({
      context: s.context ?? "",
      state: s.state ?? "",
      description: s.description ?? null,
    }));
  } catch {
    return [];
  }
}

export async function closePR(prNumber: number, deleteBranch: boolean): Promise<void> {
  const args = ["pr", "close", String(prNumber), "--repo", SANDBOX_REPO];
  if (deleteBranch) args.push("--delete-branch");
  try {
    await shx("gh", args);
  } catch {
    // already closed or branch already gone — fine
  }
}

export async function deleteRefIfExists(branch: string): Promise<void> {
  try {
    await shx("gh", [
      "api",
      "-X",
      "DELETE",
      `repos/${SANDBOX_REPO}/git/refs/heads/${branch}`,
    ]);
  } catch {
    // not present — fine
  }
}
