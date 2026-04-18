import { Config, AIProvider, PRContext, RepoConfig } from "./types.js";
import { AnthropicProvider } from "./ai/anthropic.js";
import { OpenAIProvider } from "./ai/openai.js";
import { GitHubClient } from "./github.js";
import { loadRepoConfig, mergeWithDefaults, shouldReviewPR, isPathIncluded } from "./repo-config.js";
import { formatWalkthrough, formatPRSummary, injectSummaryIntoPRBody } from "./walkthrough.js";
import { parseCommand, formatHelpMessage, formatConfigMessage } from "./commands.js";
import { LearningsStore } from "./learnings.js";
import { loadGuidelines, getRelevantGuidelines, formatGuidelinesForPrompt } from "./guidelines.js";
import { parseIssueReferences, fetchLinkedIssues, formatIssuesForPrompt, formatIssuesForWalkthrough } from "./issues.js";
import { runPreMergeChecks, formatCheckResults, getOverallStatus } from "./pre-merge.js";
import { generateDocstrings, generateTests, simplifyCode, autofix } from "./finishing-touches.js";
import { formatReviewBody } from "./review-body.js";
import { logger } from "./logger.js";

const WALKTHROUGH_MARKER = "<!-- DiffSentry Walkthrough -->";
const STATUS_MARKER = "<!-- DiffSentry Status -->";

// In-memory state per PR
const pausedPRs = new Set<string>();
const reviewCountByPR = new Map<string, number>();
const activeReviews = new Map<string, AbortController>();

function prKey(owner: string, repo: string, pullNumber: number): string {
  return `${owner}/${repo}#${pullNumber}`;
}

export class Reviewer {
  private ai: AIProvider;
  private github: GitHubClient;
  private config: Config;
  private learnings: LearningsStore;

  constructor(config: Config) {
    this.config = config;
    this.github = new GitHubClient(config);
    this.learnings = new LearningsStore(config.learningsDir);

    if (config.aiProvider === "anthropic") {
      this.ai = new AnthropicProvider(config.anthropicApiKey!, config.anthropicModel, config.anthropicBaseUrl);
    } else {
      this.ai = new OpenAIProvider(config.openaiApiKey!, config.openaiModel, config.openaiBaseUrl);
    }
  }

  // ─── Abort on PR Close ───────────────────────────────────────
  handlePRClose(owner: string, repo: string, pullNumber: number): void {
    const key = prKey(owner, repo, pullNumber);
    const controller = activeReviews.get(key);
    if (controller) {
      logger.info({ owner, repo, pr: pullNumber }, "Aborting in-flight review (PR closed)");
      controller.abort();
      activeReviews.delete(key);
    }
    // Clean up state
    pausedPRs.delete(key);
    reviewCountByPR.delete(key);
  }

  // ─── Main PR Review Handler ──────────────────────────────────
  async handlePullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    mode: "full" | "incremental"
  ): Promise<void> {
    const log = logger.child({ owner, repo, pr: pullNumber, mode });
    const key = prKey(owner, repo, pullNumber);

    // Check if paused
    if (pausedPRs.has(key)) {
      log.info("Reviews paused for this PR, skipping");
      return;
    }

    // Set up abort controller
    const abortController = new AbortController();
    activeReviews.set(key, abortController);

    try {
      // Load repo config
      log.info("Loading repo configuration");
      const octokit = await this.github.getInstallationOctokit(installationId);
      const rawConfig = await loadRepoConfig(octokit, owner, repo, "HEAD");
      const repoConfig = mergeWithDefaults(rawConfig);

      // Fetch PR context
      log.info("Fetching PR context");
      const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);

      // Check auto-review controls
      if (!shouldReviewPR(repoConfig, {
        isDraft: context.isDraft,
        labels: context.labels,
        title: context.title,
        author: context.author,
        baseBranch: context.baseBranch,
      })) {
        log.info("PR does not match auto-review criteria, skipping");
        return;
      }

      // Check auto-pause after N commits
      const pauseThreshold = repoConfig.reviews?.auto_review?.auto_pause_after_reviewed_commits;
      if (pauseThreshold && pauseThreshold > 0) {
        const count = reviewCountByPR.get(key) || 0;
        if (count >= pauseThreshold) {
          log.info({ count, threshold: pauseThreshold }, "Auto-paused after N reviewed commits");
          pausedPRs.add(key);
          await this.github.postComment(
            installationId, owner, repo, pullNumber,
            `Automatic reviews paused after ${pauseThreshold} reviewed commits. Use \`@${this.config.botName} resume\` to continue.`
          );
          return;
        }
      }

      // Post initial "in review" status comment
      const statusBody = STATUS_MARKER + "\n" +
        `> :eyes: **DiffSentry** is reviewing this ${mode === "full" ? "pull request" : "update"}... hang tight.`;
      try {
        await this.github.upsertComment(
          installationId, owner, repo, pullNumber,
          statusBody, STATUS_MARKER
        );
        log.info("Posted in-review status comment");
      } catch (err) {
        log.warn({ err }, "Failed to post in-review status comment");
      }

      // Set pending commit status
      if (repoConfig.reviews?.commit_status !== false) {
        await this.github.setCommitStatus(
          installationId, owner, repo, context.headSha,
          "pending", "Review in progress...", "DiffSentry"
        ).catch((err) => log.warn({ err }, "Failed to set pending commit status"));
      }

      if (abortController.signal.aborted) return;

      // Auto-resolve addressed review threads on incremental reviews
      if (mode === "incremental") {
        const changedFiles = context.files.map((f) => f.filename);
        try {
          const resolved = await this.github.resolveAddressedThreads(
            installationId, owner, repo, pullNumber, changedFiles
          );
          if (resolved > 0) {
            log.info({ resolved }, "Auto-resolved addressed review threads");
          }
        } catch (err) {
          log.warn({ err }, "Failed to auto-resolve review threads");
        }
      }

      // Apply path filters from repo config — capture excluded paths for review-info reporting
      const filesIgnoredByPathFilter: Array<{ path: string; reason: string }> = [];
      if (repoConfig.reviews?.path_filters) {
        const filters = repoConfig.reviews.path_filters;
        const next: typeof context.files = [];
        for (const f of context.files) {
          if (isPathIncluded(repoConfig, f.filename)) {
            next.push(f);
          } else {
            const matched = filters.find((p) =>
              p.startsWith("!") && new RegExp("^" + p.slice(1).replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$").test(f.filename),
            );
            filesIgnoredByPathFilter.push({ path: f.filename, reason: matched ?? "path_filters" });
          }
        }
        context.files = next;
      }

      const filesNoReviewableChanges = context.files
        .filter((f) => !f.patch || f.patch.trim().length === 0)
        .map((f) => f.filename);

      if (context.files.length === 0) {
        log.info("No reviewable files in PR, skipping");
        if (repoConfig.reviews?.commit_status !== false) {
          await this.github.setCommitStatus(
            installationId, owner, repo, context.headSha,
            "success", "No reviewable files", "DiffSentry"
          ).catch(() => {});
        }
        return;
      }

      // Load knowledge in parallel: learnings, guidelines, linked issues
      const repoFullName = `${owner}/${repo}`;
      const filenames = context.files.map((f) => f.filename);

      const [relevantLearnings, allGuidelines, issueNumbers] = await Promise.all([
        this.learnings.getRelevantLearnings(repoFullName, filenames),
        loadGuidelines(octokit, owner, repo, context.headSha),
        Promise.resolve(parseIssueReferences(context.description)),
      ]);

      const relevantGuidelines = getRelevantGuidelines(allGuidelines, filenames);
      const linkedIssues = issueNumbers.length > 0
        ? await fetchLinkedIssues(octokit, owner, repo, issueNumbers)
        : [];

      if (abortController.signal.aborted) return;

      // Build enhanced prompt context by injecting knowledge into the AI prompt
      // (Guidelines and issues are injected via the prompt builder's learnings param)
      const knowledgeLearnings = [...relevantLearnings];
      // Add guideline content as synthetic learnings
      const guidelinesPrompt = formatGuidelinesForPrompt(relevantGuidelines);
      const issuesPrompt = formatIssuesForPrompt(linkedIssues);

      // Inject language preference
      if (repoConfig.language) {
        knowledgeLearnings.unshift({
          id: "__lang__",
          repo: repoFullName,
          content: `Respond in ${repoConfig.language} language.`,
          createdAt: "",
        });
      }

      // Run walkthrough and review in parallel
      log.info({ fileCount: context.files.length }, "Starting AI review");

      const walkthroughEnabled = repoConfig.reviews?.walkthrough?.enabled !== false;
      const summaryEnabled = repoConfig.reviews?.high_level_summary !== false;

      const [reviewResult, walkthroughResult] = await Promise.all([
        this.ai.review(context, repoConfig, relevantLearnings),
        walkthroughEnabled || summaryEnabled
          ? this.ai.generateWalkthrough(context, repoConfig)
          : Promise.resolve(null),
      ]);

      if (abortController.signal.aborted) return;

      // Find related PRs for walkthrough
      let relatedPRsSection = "";
      if (walkthroughEnabled) {
        try {
          const relatedPRs = await this.github.findRelatedPRs(
            installationId, owner, repo, pullNumber, filenames
          );
          if (relatedPRs.length > 0) {
            const rows = relatedPRs
              .map((pr) => `| [#${pr.number}](${pr.url}) | ${pr.title} | ${pr.state} |`)
              .join("\n");
            relatedPRsSection = `\n\n## Related PRs\n\n| PR | Title | State |\n|---|-------|-------|\n${rows}`;
          }
        } catch {
          // Best effort
        }
      }

      // Post walkthrough comment
      if (walkthroughResult && walkthroughEnabled) {
        const walkthroughConfig = repoConfig.reviews?.walkthrough || {};
        let walkthroughBody =
          WALKTHROUGH_MARKER +
          "\n" +
          formatWalkthrough(walkthroughResult, walkthroughConfig);

        // Append linked issues section
        if (linkedIssues.length > 0) {
          walkthroughBody += "\n\n" + formatIssuesForWalkthrough(linkedIssues);
        }

        // Append related PRs
        if (relatedPRsSection) {
          walkthroughBody += relatedPRsSection;
        }

        try {
          await this.github.upsertComment(
            installationId, owner, repo, pullNumber,
            walkthroughBody, WALKTHROUGH_MARKER
          );
          log.info("Walkthrough comment posted");
        } catch (err) {
          log.warn({ err }, "Failed to post walkthrough comment");
        }
      }

      // Inject summary into PR description
      if (walkthroughResult && summaryEnabled) {
        try {
          const prSummary = formatPRSummary(walkthroughResult);
          const newBody = injectSummaryIntoPRBody(context.description, prSummary);
          await this.github.updatePRDescription(installationId, owner, repo, pullNumber, newBody);
          log.info("PR description updated with summary");
        } catch (err) {
          log.warn({ err }, "Failed to update PR description");
        }
      }

      // Auto-apply labels
      if (repoConfig.reviews?.auto_apply_labels && walkthroughResult?.suggestedLabels?.length) {
        await this.github.applyLabels(
          installationId, owner, repo, pullNumber,
          walkthroughResult.suggestedLabels
        );
      }

      // Auto-assign reviewers
      if (repoConfig.reviews?.auto_assign_reviewers && walkthroughResult?.suggestedReviewers?.length) {
        await this.github.assignReviewers(
          installationId, owner, repo, pullNumber,
          walkthroughResult.suggestedReviewers
        );
      }

      // Compose CodeRabbit-style review body before submission
      reviewResult.summary = formatReviewBody(reviewResult, {
        profile: repoConfig.reviews?.profile ?? "chill",
        baseSha: undefined,
        headSha: context.headSha,
        baseBranch: context.baseBranch,
        headBranch: context.headBranch,
        filesProcessed: context.files.map((f) => f.filename),
        filesIgnoredByPathFilter,
        filesNoReviewableChanges,
        configUsed: rawConfig ? "`.diffsentry.yaml`" : "defaults",
        plan: undefined,
        botName: this.config.botName,
      });

      // Submit the code review
      log.info(
        { commentCount: reviewResult.comments.length, approval: reviewResult.approval },
        "Review complete, submitting to GitHub"
      );
      await this.github.submitReview(installationId, context, reviewResult);

      // Run pre-merge checks
      if (repoConfig.reviews?.pre_merge_checks) {
        try {
          const checkResults = await runPreMergeChecks(
            context,
            repoConfig.reviews.pre_merge_checks,
            async (instruction, ctx) => {
              const response = await this.ai.chat(ctx, `Pre-merge check: ${instruction}\n\nRespond with JSON: {"passed": true/false, "message": "reason"}`);
              try {
                const parsed = JSON.parse(response.replace(/^```json?\s*\n?/, "").replace(/\n?\s*```$/, ""));
                return { passed: !!parsed.passed, message: parsed.message || "" };
              } catch {
                return { passed: true, message: "Could not evaluate" };
              }
            }
          );

          if (checkResults.length > 0) {
            const checksComment = formatCheckResults(checkResults);
            await this.github.postComment(installationId, owner, repo, pullNumber, checksComment);

            const status = getOverallStatus(checkResults);
            if (repoConfig.reviews?.commit_status !== false) {
              const statusMap = { pass: "success" as const, warning: "success" as const, fail: "failure" as const };
              await this.github.setCommitStatus(
                installationId, owner, repo, context.headSha,
                statusMap[status],
                status === "fail" ? "Pre-merge checks failed" : "Pre-merge checks passed",
                "DiffSentry / Pre-Merge"
              ).catch(() => {});
            }
          }
        } catch (err) {
          log.warn({ err }, "Pre-merge checks failed");
        }
      }

      // Update status comment to show completion
      const approvalEmoji = reviewResult.approval === "APPROVE" ? ":white_check_mark:"
        : reviewResult.approval === "REQUEST_CHANGES" ? ":x:" : ":speech_balloon:";
      const approvalText = reviewResult.approval === "APPROVE" ? "Looks good!"
        : reviewResult.approval === "REQUEST_CHANGES" ? "Changes requested"
        : "Review complete with comments";
      const finalStatusBody = STATUS_MARKER + "\n" +
        `> ${approvalEmoji} **DiffSentry** has completed the review — ${approvalText}`;
      try {
        await this.github.upsertComment(
          installationId, owner, repo, pullNumber,
          finalStatusBody, STATUS_MARKER
        );
      } catch (err) {
        log.warn({ err }, "Failed to update status comment");
      }

      // Set final commit status
      if (repoConfig.reviews?.commit_status !== false) {
        const statusMap = {
          APPROVE: "success" as const,
          COMMENT: "success" as const,
          REQUEST_CHANGES: "failure" as const,
        };
        await this.github.setCommitStatus(
          installationId, owner, repo, context.headSha,
          statusMap[reviewResult.approval],
          reviewResult.approval === "APPROVE"
            ? "Looks good!"
            : reviewResult.approval === "REQUEST_CHANGES"
            ? "Changes requested"
            : "Review complete with comments",
          "DiffSentry"
        ).catch((err) => log.warn({ err }, "Failed to set commit status"));
      }

      // Track review count for auto-pause
      const currentCount = reviewCountByPR.get(key) || 0;
      reviewCountByPR.set(key, currentCount + 1);

    } catch (err) {
      if (abortController.signal.aborted) {
        log.info("Review aborted (PR closed)");
        return;
      }
      log.error({ err }, "Review failed");
      throw err;
    } finally {
      activeReviews.delete(key);
    }
  }

  // ─── Chat Command Handler ────────────────────────────────────
  async handleComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentBody: string,
    commentId: number
  ): Promise<void> {
    const log = logger.child({ owner, repo, pr: pullNumber, commentId });
    const key = prKey(owner, repo, pullNumber);

    const command = parseCommand(commentBody, this.config.botName);
    if (!command) {
      log.debug("No command found in comment");
      return;
    }

    log.info({ commandType: command.type }, "Processing command");

    try {
      switch (command.type) {
        case "help": {
          const helpText = formatHelpMessage(this.config.botName);
          await this.github.replyToComment(installationId, owner, repo, pullNumber, commentId, helpText);
          break;
        }

        case "review": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Starting incremental review..."
          );
          await this.handlePullRequest(installationId, owner, repo, pullNumber, "incremental");
          break;
        }

        case "full_review": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Starting full review..."
          );
          await this.handlePullRequest(installationId, owner, repo, pullNumber, "full");
          break;
        }

        case "pause": {
          pausedPRs.add(key);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            `Automatic reviews **paused** for this PR. Use \`@${this.config.botName} resume\` to re-enable.`
          );
          break;
        }

        case "resume": {
          pausedPRs.delete(key);
          reviewCountByPR.delete(key); // Reset count on resume
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Automatic reviews **resumed** for this PR."
          );
          break;
        }

        case "resolve": {
          await this.github.resolveAllComments(installationId, owner, repo, pullNumber);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "All review comments have been marked as resolved."
          );
          break;
        }

        case "summary": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Regenerating summary..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, "HEAD");
          const repoConfig = mergeWithDefaults(rawConfig);

          const walkthroughResult = await this.ai.generateWalkthrough(context, repoConfig);
          const walkthroughConfig = repoConfig.reviews?.walkthrough || {};
          const walkthroughBody =
            WALKTHROUGH_MARKER + "\n" + formatWalkthrough(walkthroughResult, walkthroughConfig);
          await this.github.upsertComment(installationId, owner, repo, pullNumber, walkthroughBody, WALKTHROUGH_MARKER);

          const prSummary = formatPRSummary(walkthroughResult);
          const newBody = injectSummaryIntoPRBody(context.description, prSummary);
          await this.github.updatePRDescription(installationId, owner, repo, pullNumber, newBody);
          break;
        }

        case "configuration": {
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, "HEAD");
          const repoConfig = mergeWithDefaults(rawConfig);
          const configMsg = formatConfigMessage(repoConfig, {
            aiProvider: this.config.aiProvider,
            maxFilesPerReview: this.config.maxFilesPerReview,
            botName: this.config.botName,
          });
          await this.github.replyToComment(installationId, owner, repo, pullNumber, commentId, configMsg);
          break;
        }

        case "learn": {
          const repoFullName = `${owner}/${repo}`;
          await this.learnings.addLearning(repoFullName, command.content);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            `Learning saved. I'll apply this in future reviews of **${owner}/${repo}**.`
          );
          break;
        }

        case "generate_docstrings": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Generating docstrings for changed files..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await generateDocstrings(octokit, context, this.ai);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            result.filesChanged > 0
              ? `Added docstrings to ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No files needed docstring updates."
          );
          break;
        }

        case "generate_tests": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Generating unit tests for changed files..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await generateTests(octokit, context, this.ai);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            result.filesChanged > 0
              ? `Generated tests in ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "Could not generate tests for these changes."
          );
          break;
        }

        case "simplify": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Analyzing changed code for simplification opportunities..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await simplifyCode(octokit, context, this.ai);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            result.filesChanged > 0
              ? `Simplified ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No simplification opportunities found."
          );
          break;
        }

        case "autofix": {
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            "Applying fixes from review comments..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await autofix(octokit, context, this.ai);
          await this.github.replyToComment(
            installationId, owner, repo, pullNumber, commentId,
            result.filesChanged > 0
              ? `Applied fixes to ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No actionable fixes found in review comments."
          );
          break;
        }

        case "chat": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, "HEAD");
          const repoConfig = mergeWithDefaults(rawConfig);
          const response = await this.ai.chat(context, command.message, repoConfig);
          await this.github.replyToComment(installationId, owner, repo, pullNumber, commentId, response);
          break;
        }
      }
    } catch (err) {
      log.error({ err, commandType: command.type }, "Command handling failed");
      try {
        await this.github.replyToComment(
          installationId, owner, repo, pullNumber, commentId,
          "Sorry, I encountered an error processing your request. Please try again."
        );
      } catch {
        // Give up on error reporting
      }
    }
  }
}
