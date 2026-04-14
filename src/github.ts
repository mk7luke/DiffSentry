import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Config, FileChange, PRContext, ReviewResult } from "./types.js";
import { logger } from "./logger.js";

export class GitHubClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private async getInstallationOctokit(installationId: number): Promise<Octokit> {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.githubAppId,
        privateKey: this.config.githubPrivateKey,
        installationId,
      },
    });
  }

  async getPRContext(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PRContext> {
    const octokit = await this.getInstallationOctokit(installationId);

    const [pr, filesResponse] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
      octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 }),
    ]);

    const files: FileChange[] = filesResponse.data
      .filter((f) => !this.isIgnored(f.filename))
      .slice(0, this.config.maxFilesPerReview)
      .map((f) => ({
        filename: f.filename,
        status: f.status as FileChange["status"],
        patch: f.patch || "",
        additions: f.additions,
        deletions: f.deletions,
      }));

    return {
      owner,
      repo,
      pullNumber,
      title: pr.data.title,
      description: pr.data.body || "",
      baseBranch: pr.data.base.ref,
      headBranch: pr.data.head.ref,
      files,
    };
  }

  async submitReview(
    installationId: number,
    context: PRContext,
    result: ReviewResult
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner: context.owner, repo: context.repo, pr: context.pullNumber });

    // Dismiss previous DiffSentry reviews so we don't pile up stale comments
    try {
      const reviews = await octokit.pulls.listReviews({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
      });
      const botReviews = reviews.data.filter(
        (r) => r.user?.type === "Bot" && r.state === "CHANGES_REQUESTED"
      );
      for (const review of botReviews) {
        await octokit.pulls.dismissReview({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          review_id: review.id,
          message: "Superseded by new review.",
        });
      }
    } catch {
      log.warn("Could not dismiss previous reviews (may lack permission)");
    }

    // Submit the new review
    const validComments = result.comments.filter((c) => c.line > 0 && c.path);

    try {
      await octokit.pulls.createReview({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.pullNumber,
        event: result.approval,
        body: result.summary,
        comments: validComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      log.info(
        { comments: validComments.length, event: result.approval },
        "Review submitted"
      );
    } catch (err: any) {
      // If inline comments fail (line not in diff), fall back to a plain comment
      if (err.status === 422 && validComments.length > 0) {
        log.warn("Inline comments failed, falling back to summary-only review");
        const commentBlock = validComments
          .map((c) => `**${c.path}:${c.line}**\n${c.body}`)
          .join("\n\n---\n\n");

        await octokit.pulls.createReview({
          owner: context.owner,
          repo: context.repo,
          pull_number: context.pullNumber,
          event: result.approval,
          body: `${result.summary}\n\n---\n\n## Inline Comments\n\n${commentBlock}`,
        });
      } else {
        throw err;
      }
    }
  }

  private isIgnored(filename: string): boolean {
    return this.config.ignoredPatterns.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
        );
        return regex.test(filename);
      }
      return filename === pattern || filename.endsWith(pattern);
    });
  }
}
