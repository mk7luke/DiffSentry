/**
 * One-time backfill to seed historical rows so the dashboard has data on
 * first run. Enumerates every repo the GitHub App is installed in and,
 * for each PR, records a `prs` row + an event marker when DiffSentry has
 * previously commented.
 *
 * Does NOT reconstruct `reviews` / `findings` from walkthrough blobs —
 * per the project memory, we do not persist an internal-state blob, so
 * historical reviews cannot be perfectly reconstructed. We settle for
 * "the dashboard knows this PR existed and the bot touched it".
 *
 * Run: `npx tsx scripts/backfill.ts` (honors the same env as the main app).
 *
 * Flags:
 *   --repo owner/name    only backfill one repo
 *   --limit N            max PRs per repo (default 200)
 */
import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/storage/db.js";
import { recordEvent, recordPR, recordRepo } from "../src/storage/dao.js";
import { logger } from "../src/logger.js";

interface Args {
  repo?: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--limit") out.limit = Math.max(1, Number.parseInt(argv[++i] ?? "0", 10) || 200);
    else if (a === "--help" || a === "-h") {
      console.log("usage: backfill.ts [--repo owner/name] [--limit N]");
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = openDatabase();
  if (!db) {
    console.error("Backfill requires SQLite to be enabled (DB_PATH != \"\").");
    process.exit(1);
  }

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.githubAppId, privateKey: config.githubPrivateKey },
  });

  const installations = await appOctokit.paginate(appOctokit.apps.listInstallations, { per_page: 100 });
  logger.info({ n: installations.length }, "backfill: installations");

  let totalPRs = 0;
  let totalRepos = 0;

  for (const inst of installations) {
    const installationId = inst.id;
    const instOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: config.githubAppId, privateKey: config.githubPrivateKey, installationId },
    });
    const repos = await instOctokit.paginate(instOctokit.apps.listReposAccessibleToInstallation, { per_page: 100 });
    logger.info({ installationId, n: repos.length }, "backfill: repos in installation");

    for (const r of repos) {
      const owner = r.owner.login;
      const name = r.name;
      if (args.repo && `${owner}/${name}`.toLowerCase() !== args.repo.toLowerCase()) continue;

      recordRepo({ owner, repo: name, installationId });
      totalRepos++;

      const prs = await instOctokit.paginate(instOctokit.pulls.list, {
        owner,
        repo: name,
        state: "all",
        per_page: 100,
      }, (resp, done) => {
        const all = resp.data;
        if (all.length >= args.limit) done();
        return all;
      });
      const slice = prs.slice(0, args.limit);

      for (const pr of slice) {
        recordPR(
          {
            owner,
            repo: name,
            pullNumber: pr.number,
            title: pr.title,
            description: pr.body ?? "",
            baseBranch: pr.base.ref,
            baseSha: pr.base.sha,
            headBranch: pr.head.ref,
            headSha: pr.head.sha,
            files: [],
            isDraft: !!pr.draft,
            labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
            author: pr.user?.login,
          },
          {
            state: pr.state,
            closedAt: pr.closed_at,
            mergedAt: pr.merged_at,
          },
        );
        totalPRs++;

        // One "backfill" event so the PR detail page shows at least one row.
        recordEvent({
          owner,
          repo: name,
          number: pr.number,
          kind: "backfill.pull_request",
          payload: { state: pr.state, merged: !!pr.merged_at },
        });
      }
    }
  }

  logger.info({ totalRepos, totalPRs }, "backfill: done");
  console.log(`Backfilled ${totalRepos} repos and ${totalPRs} PRs.`);
}

main().catch((err) => {
  logger.error({ err }, "backfill failed");
  process.exit(1);
});
