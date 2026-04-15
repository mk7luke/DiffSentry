import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Config, FileChange, PRContext, ReviewResult } from "./types.js";
import { logger } from "./logger.js";

export class GitHubClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async getInstallationOctokit(installationId: number): Promise<Octokit> {
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
      headSha: pr.data.head.sha,
      files,
      isDraft: pr.data.draft,
      labels: pr.data.labels.map((l) => l.name ?? ""),
      author: pr.data.user?.login,
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
        commit_id: context.headSha,
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
          commit_id: context.headSha,
          event: result.approval,
          body: `${result.summary}\n\n---\n\n## Inline Comments\n\n${commentBlock}`,
        });
      } else {
        throw err;
      }
    }
  }

  async postComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async upsertComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    marker: string
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });

    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existing = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.includes(marker)
    );

    if (existing) {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      log.info({ commentId: existing.id }, "Updated existing walkthrough comment");
    } else {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      log.info("Created new walkthrough comment");
    }
  }

  async updatePRDescription(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    await octokit.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      body,
    });
  }

  async getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    const octokit = await this.getInstallationOctokit(installationId);
    try {
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      const data = response.data as { content?: string; encoding?: string };
      if (data.content) {
        return Buffer.from(data.content, "base64").toString();
      }
      return null;
    } catch (err: any) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async replyToComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    _commentId: number,
    body: string
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    // Post as an issue comment — works for both issue_comment and review_comment triggers
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async resolveAllComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: "All comments resolved by request.",
    });
    log.info("Posted resolve-all notice");
  }

  // ─── Commit Status ──────────────────────────────────────────
  async setCommitStatus(
    installationId: number,
    owner: string,
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    context: string = "DiffSentry"
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      description,
      context,
    });
  }

  // ─── Labels ────────────────────────────────────────────────
  async applyLabels(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[]
  ): Promise<void> {
    if (labels.length === 0) return;
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels,
      });
      log.info({ labels }, "Labels applied");
    } catch (err) {
      log.warn({ err, labels }, "Failed to apply labels (labels may not exist)");
    }
  }

  // ─── Reviewers ─────────────────────────────────────────────
  async assignReviewers(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    reviewers: string[]
  ): Promise<void> {
    if (reviewers.length === 0) return;
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });
    // Strip @ prefix if present
    const cleaned = reviewers.map((r) => r.replace(/^@/, ""));
    try {
      await octokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: pullNumber,
        reviewers: cleaned,
      });
      log.info({ reviewers: cleaned }, "Reviewers assigned");
    } catch (err) {
      log.warn({ err, reviewers: cleaned }, "Failed to assign reviewers");
    }
  }

  // ─── Search Related PRs ────────────────────────────────────
  async findRelatedPRs(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    changedFiles: string[]
  ): Promise<Array<{ number: number; title: string; url: string; state: string }>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const results: Array<{ number: number; title: string; url: string; state: string }> = [];
    try {
      // Find open PRs that touch the same files (limited search)
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 20,
      });
      for (const pr of prs) {
        if (pr.number === pullNumber) continue;
        try {
          const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pr.number,
            per_page: 50,
          });
          const overlap = files.some((f) => changedFiles.includes(f.filename));
          if (overlap) {
            results.push({
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              state: pr.state,
            });
          }
        } catch {
          // Skip PRs we can't read
        }
        if (results.length >= 5) break;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to search related PRs");
    }
    return results;
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
