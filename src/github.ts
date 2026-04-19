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
      baseSha: pr.data.base.sha,
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

    // GitHub rejects reviews with empty body and no comments (422)
    if (!result.summary && validComments.length === 0) {
      log.warn("Skipping review submission: no summary and no comments");
      return;
    }

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

  async listPRCommits(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<Array<{ sha: string; message: string; author?: string }>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const commits = await octokit.paginate(octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return commits.map((c: any) => ({
      sha: c.sha,
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name,
    }));
  }

  async findCommentByMarker(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    marker: string,
  ): Promise<{ id: number; body: string } | null> {
    const octokit = await this.getInstallationOctokit(installationId);
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });
    const existing = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.includes(marker),
    );
    if (!existing) return null;
    return { id: existing.id, body: existing.body ?? "" };
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
    commentId: number,
    body: string,
    kind: "issue" | "review_thread" = "issue"
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    if (kind === "review_thread") {
      // Reply inside the existing review thread so the conversation stays
      // collapsed under the diff hunk instead of fragmenting into a new
      // top-level issue comment.
      try {
        await octokit.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          comment_id: commentId,
          body,
        });
        return;
      } catch (err) {
        logger.warn({ err, commentId }, "createReplyForReviewComment failed, falling back to issue comment");
        // fall through to issue-comment fallback
      }
    }
    // Post as an issue comment (default + fallback)
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

    const resolved = await this.resolveReviewThreads(octokit, owner, repo, pullNumber);
    log.info({ resolved }, "Resolved all review threads");
  }

  /**
   * Resolve review threads on a PR where DiffSentry left comments on files
   * that were modified in the latest push. Uses GraphQL since the REST API
   * doesn't support resolving review threads.
   */
  async resolveAddressedThreads(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    changedFiles: string[]
  ): Promise<number> {
    const octokit = await this.getInstallationOctokit(installationId);
    const log = logger.child({ owner, repo, pr: pullNumber });

    try {
      // Fetch all review threads via GraphQL
      const query = `
        query($owner: String!, $repo: String!, $pr: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pr) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  path
                  comments(first: 1) {
                    nodes {
                      author {
                        login
                      }
                      authorAssociation
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const result: any = await octokit.graphql(query, { owner, repo, pr: pullNumber });
      const threads = result.repository.pullRequest.reviewThreads.nodes;

      let resolvedCount = 0;
      for (const thread of threads) {
        if (thread.isResolved) continue;

        // Only resolve threads on files changed in this push
        if (!changedFiles.includes(thread.path)) continue;

        // Only resolve threads started by a GitHub App or bot
        const firstComment = thread.comments.nodes[0];
        if (!firstComment) continue;
        const isAppAuthor = firstComment.authorAssociation === "APP" ||
          firstComment.author?.login?.endsWith("[bot]");
        if (!isAppAuthor) continue;

        try {
          await octokit.graphql(`
            mutation($threadId: ID!) {
              resolveReviewThread(input: { threadId: $threadId }) {
                thread { id }
              }
            }
          `, { threadId: thread.id });
          resolvedCount++;
        } catch (err) {
          log.warn({ err, threadId: thread.id }, "Failed to resolve thread");
        }
      }

      log.info({ resolvedCount, totalThreads: threads.length }, "Auto-resolved addressed review threads");
      return resolvedCount;
    } catch (err) {
      log.warn({ err }, "Failed to auto-resolve review threads");
      return 0;
    }
  }

  /**
   * Resolve all unresolved review threads on a PR (used by the "resolve" command).
   */
  private async resolveReviewThreads(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<number> {
    const log = logger.child({ owner, repo, pr: pullNumber });

    try {
      const query = `
        query($owner: String!, $repo: String!, $pr: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pr) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                }
              }
            }
          }
        }
      `;

      const result: any = await octokit.graphql(query, { owner, repo, pr: pullNumber });
      const threads = result.repository.pullRequest.reviewThreads.nodes;

      let resolved = 0;
      for (const thread of threads) {
        if (thread.isResolved) continue;
        try {
          await octokit.graphql(`
            mutation($threadId: ID!) {
              resolveReviewThread(input: { threadId: $threadId }) {
                thread { id }
              }
            }
          `, { threadId: thread.id });
          resolved++;
        } catch (err) {
          log.warn({ err, threadId: thread.id }, "Failed to resolve thread");
        }
      }
      return resolved;
    } catch (err) {
      log.warn({ err }, "Failed to resolve review threads via GraphQL");
      return 0;
    }
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
