import { randomUUID } from "node:crypto";
import { Config, AIProvider, PRContext, RepoConfig } from "./types.js";
import { AnthropicProvider } from "./ai/anthropic.js";
import { OpenAIProvider } from "./ai/openai.js";
import { OpenAICompatibleProvider } from "./ai/openai-compatible.js";
import { GitHubClient } from "./github.js";
import { loadRepoConfig, mergeWithDefaults, shouldReviewPR, isPathIncluded } from "./repo-config.js";
import { formatWalkthrough, formatWalkthroughInner, wrapWalkthroughCollapse, formatPRSummary, injectSummaryIntoPRBody } from "./walkthrough.js";
import { parseCommand, formatHelpMessage, formatConfigMessage } from "./commands.js";
import { LearningsStore } from "./learnings.js";
import { loadGuidelines, getRelevantGuidelines, formatGuidelinesForPrompt } from "./guidelines.js";
import { parseIssueReferences, fetchLinkedIssues, formatIssuesForPrompt, formatIssuesForWalkthrough } from "./issues.js";
import { runPreMergeChecks, formatCheckResults, getOverallStatus } from "./pre-merge.js";
import { generateDocstrings, generateTests, simplifyCode, autofix } from "./finishing-touches.js";
import { formatReviewBody } from "./review-body.js";
import { encodeState, extractState, isTrivialPatch, WalkthroughState } from "./walkthrough-state.js";
import { assessRisk, renderRiskBlock, assessCoverage, renderCoverageBlock, shouldSuggestSplit, renderSplitSuggestion, renderConfidenceAggregate, computeReviewerDeltas, renderReviewerDeltaBlock } from "./insights.js";
import { suggestReviewersFromBlame, renderSuggestedReviewers, combineReviewers, renderCombinedReviewers } from "./blame-reviewers.js";
import { loadCodeowners, ownersForFiles, renderCodeownersBlock } from "./codeowners.js";
import { findPriorBotThreadsForPaths, renderPriorDiscussionsBlock, diffWithOtherPR, renderDiffPRReply } from "./cross-pr.js";
import { renderStickyStatus, STICKY_MARKER } from "./sticky-status.js";
import { recordRepo, recordPR, recordReview, recordFindings, recordPatternHits } from "./storage/dao.js";
import { runSafetyScanners } from "./safety-scanner.js";
import { runPatternChecks } from "./pattern-checks.js";
import { scanDependencyChanges, renderDepBlock } from "./dep-scanner.js";
import { detectDescriptionDrift, renderDriftBlock, reviewCommitMessages, renderCommitCoachBlock, reviewPRTitle, renderTitleCoachBlock, scanLicenseHeaders, renderLicenseHeaderBlock } from "./drift.js";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";

function normalizePatchForHash(patch: string): string {
  // Strip metadata lines + leading +/- markers, collapse all whitespace,
  // drop blanks. Patch hash now survives re-indenting and trivial reflows.
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("---") && !l.startsWith("+++"))
    .map((l) => l.replace(/^[+-]/, ""))
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function patchHash(patch: string): string {
  return createHash("sha256").update(normalizePatchForHash(patch)).digest("hex").slice(0, 16);
}

const WALKTHROUGH_MARKER = "<!-- DiffSentry Walkthrough -->";
const WALKTHROUGH_START = "<!-- walkthrough_start -->";
const WALKTHROUGH_END = "<!-- walkthrough_end -->";
const STATUS_MARKER = "<!-- DiffSentry Status -->";

function tipsFooter(botName: string): string {
  return `\n\n---\n\n<sub>Comment \`@${botName} help\` to get the list of available commands and usage tips.</sub>`;
}

function finishingTouchesBlock(): string {
  const id1 = randomUUID();
  const id2 = randomUUID();
  const id3 = randomUUID();
  const id4 = randomUUID();
  return [
    "<details>",
    "<summary>✨ Finishing Touches</summary>",
    "",
    "<details>",
    "<summary>🧪 Generate unit tests (beta)</summary>",
    "",
    `- [ ] <!-- {"checkboxId": "${id1}"} -->   Create PR with unit tests`,
    "",
    "</details>",
    "",
    "<details>",
    "<summary>📝 Generate docstrings (beta)</summary>",
    "",
    `- [ ] <!-- {"checkboxId": "${id2}"} -->   Push docstring commit to this branch`,
    "",
    "</details>",
    "",
    "<details>",
    "<summary>🧹 Simplify (beta)</summary>",
    "",
    `- [ ] <!-- {"checkboxId": "${id3}"} -->   Push simplification commit to this branch`,
    "",
    "</details>",
    "",
    "<details>",
    "<summary>🪄 Autofix unresolved comments (beta)</summary>",
    "",
    `- [ ] <!-- {"checkboxId": "${id4}"} -->   Push autofix commit to this branch`,
    "",
    "</details>",
    "",
    "</details>",
  ].join("\n");
}

function actionsPerformed(action: string, note?: string): string {
  const inner = note ? `${action}\n\n> ${note}` : action;
  return [
    "<details>",
    "<summary>✅ Actions performed</summary>",
    "",
    inner,
    "",
    "</details>",
    "",
    "<!-- This is an auto-generated reply by DiffSentry -->",
  ].join("\n");
}

function pauseNotice(botName: string, reason: "manual" | "auto", threshold?: number): string {
  const heading = "## Reviews paused";
  const body = reason === "auto" && threshold
    ? `It looks like this branch is under active development. To avoid overwhelming you with review comments, DiffSentry has automatically paused after ${threshold} reviewed commits. You can configure this behavior by changing the \`reviews.auto_review.auto_pause_after_reviewed_commits\` setting.`
    : `Automatic reviews are paused for this PR.`;
  return [
    "> [!NOTE]",
    `> ${heading}`,
    "> ",
    `> ${body}`,
    "> ",
    "> Use the following commands to manage reviews:",
    `> - \`@${botName} resume\` to resume automatic reviews.`,
    `> - \`@${botName} review\` to trigger a single review.`,
  ].join("\n");
}

function resumeNotice(): string {
  return [
    "> [!NOTE]",
    "> ## Reviews resumed",
    "> ",
    "> Automatic reviews have been re-enabled for this PR.",
  ].join("\n");
}

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
    } else if (config.aiProvider === "openai-compatible") {
      this.ai = new OpenAICompatibleProvider({
        baseURL: config.localAiBaseUrl!,
        model: config.localAiModel,
        apiKey: config.localAiApiKey,
        jsonMode: config.localAiJsonMode,
      });
    } else {
      this.ai = new OpenAIProvider(config.openaiApiKey!, config.openaiModel, config.openaiBaseUrl);
    }
  }

  // ─── Public helper for server.ts (parent-comment lookup) ───
  async getInstallationOctokit(installationId: number) {
    return this.github.getInstallationOctokit(installationId);
  }

  // ─── Push-driven auto-resolve (runs even when reviews are paused) ─────
  async autoResolveOnPush(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    const log = logger.child({ owner, repo, pr: pullNumber });
    try {
      const ctx = await this.github.getPRContext(installationId, owner, repo, pullNumber);
      const changedFiles = ctx.files.map((f) => f.filename);
      if (changedFiles.length === 0) return;
      const resolved = await this.github.resolveAddressedThreads(
        installationId, owner, repo, pullNumber, changedFiles
      );
      if (resolved > 0) log.info({ resolved }, "Push auto-resolve: closed addressed threads");
    } catch (err) {
      log.warn({ err }, "Push auto-resolve failed");
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
      // Fetch PR context first so we can load .diffsentry.yaml from the PR's
      // head ref — that way config changes inside the PR take effect for it.
      log.info("Fetching PR context");
      const octokit = await this.github.getInstallationOctokit(installationId);
      const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);

      // Load repo config from the PR's head ref
      log.info("Loading repo configuration");
      const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
      const repoConfig = mergeWithDefaults(rawConfig);

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
            pauseNotice(this.config.botName, "auto", pauseThreshold),
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

      // Note: push-driven auto-resolve now runs from server.ts on synchronize
      // *before* this gated path, so paused/draft/ignored PRs still resolve
      // addressed threads.

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

      // Recover state from any previously-posted walkthrough comment so the
      // bot can do real incremental reviews after a restart and surface
      // skipped-file lists in the review-info block.
      const priorComment = await this.github
        .findCommentByMarker(installationId, owner, repo, pullNumber, WALKTHROUGH_MARKER)
        .catch(() => null);
      const priorState = priorComment ? extractState(priorComment.body) : null;
      const priorFingerprints = new Set(priorState?.postedFingerprints ?? []);

      // Classify each file against prior state
      const currentFileShas: Record<string, string> = {};
      const filesSkippedSimilar: string[] = [];
      const filesSkippedTrivial: string[] = [];
      const filesToReview: typeof context.files = [];
      for (const f of context.files) {
        const ph = patchHash(f.patch);
        currentFileShas[f.filename] = ph;
        if (isTrivialPatch(f.patch)) {
          filesSkippedTrivial.push(f.filename);
          continue;
        }
        if (mode === "incremental" && priorState?.fileShas?.[f.filename] === ph) {
          filesSkippedSimilar.push(f.filename);
          continue;
        }
        filesToReview.push(f);
      }
      // Replace context.files with the trimmed set so the AI prompt + review
      // submission only operate on what actually changed.
      context.files = filesToReview;

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
            const bullets = relatedPRs
              .map((pr) => `- [${owner}/${repo}#${pr.number}](${pr.url}) — ${pr.title}`)
              .join("\n");
            relatedPRsSection = `\n\n## Possibly related PRs\n\n${bullets}`;
          }
        } catch {
          // Best effort
        }
      }

      // Run pre-merge checks ahead of the walkthrough so the result block can
      // be embedded in the walkthrough comment as a sibling <details>.
      let preMergeBlock = "";
      let preMergeStatus: "pass" | "warning" | "fail" | null = null;
      if (repoConfig.reviews?.pre_merge_checks) {
        try {
          const checkResults = await runPreMergeChecks(
            context,
            repoConfig.reviews.pre_merge_checks,
            async (instruction, ctx) => {
              const response = await this.ai.chat(
                ctx,
                `Pre-merge check: ${instruction}\n\nRespond with JSON: {"passed": true/false, "message": "reason"}`,
              );
              try {
                const parsed = JSON.parse(
                  response.replace(/^```json?\s*\n?/, "").replace(/\n?\s*```$/, ""),
                );
                return { passed: !!parsed.passed, message: parsed.message || "" };
              } catch {
                return { passed: true, message: "Could not evaluate" };
              }
            },
          );
          if (checkResults.length > 0) {
            preMergeBlock = formatCheckResults(checkResults);
            preMergeStatus = getOverallStatus(checkResults);
          }
        } catch (err) {
          log.warn({ err }, "Pre-merge checks failed");
        }
      }

      // Run safety scanners (secrets, merge markers) on the diff and merge
      // findings into the review BEFORE risk assessment so they count.
      const safetyFindings = runSafetyScanners(context.files);
      if (safetyFindings.length > 0) {
        log.info({ count: safetyFindings.length }, "Safety scanner produced findings");
        reviewResult.comments = [...safetyFindings, ...reviewResult.comments];
        // Any critical safety finding bumps the review to changes-requested
        if (safetyFindings.some((c) => c.severity === "critical")) {
          reviewResult.approval = "REQUEST_CHANGES";
        }
      }

      // Run anti-pattern + built-in heuristic checks
      const patternFindings = runPatternChecks(context.files, repoConfig);
      if (patternFindings.length > 0) {
        log.info({ count: patternFindings.length }, "Pattern checks produced findings");
        reviewResult.comments = [...patternFindings, ...reviewResult.comments];
        if (patternFindings.some((c) => c.severity === "critical")) {
          reviewResult.approval = "REQUEST_CHANGES";
        } else if (
          reviewResult.approval === "APPROVE" &&
          patternFindings.some((c) => c.severity === "major")
        ) {
          reviewResult.approval = "COMMENT";
        }
      }

      // Compute insights (risk, coverage, split suggestion) before posting
      const coverage = assessCoverage(context.files);

      // Dependency change detection (sync, no AI)
      const depDeltas = scanDependencyChanges(context.files);

      // Commit-message coach (sync, no AI)
      let commitFindings: ReturnType<typeof reviewCommitMessages> = [];
      try {
        const commits = await this.github.listPRCommits(installationId, owner, repo, pullNumber);
        commitFindings = reviewCommitMessages(commits);
      } catch (err) {
        log.debug({ err }, "listPRCommits failed");
      }

      // Description drift detection (one extra AI call, best-effort)
      let driftFindings: Awaited<ReturnType<typeof detectDescriptionDrift>> = [];
      try {
        driftFindings = await detectDescriptionDrift({ ai: this.ai, context });
      } catch (err) {
        log.debug({ err }, "Drift detection failed");
      }
      const risk = assessRisk({
        files: context.files,
        review: reviewResult,
        effortEstimate: walkthroughResult?.effortEstimate,
        hasNewTests: coverage.testAdditions > 0,
      });

      // Suggested reviewers from git blame (best-effort, falls back silently)
      let blameReviewers: Awaited<ReturnType<typeof suggestReviewersFromBlame>> = [];
      if (context.baseSha) {
        try {
          blameReviewers = await suggestReviewersFromBlame({
            octokit,
            owner,
            repo,
            baseSha: context.baseSha,
            files: context.files,
            excludeLogins: [
              context.author ?? "",
              this.config.botName,
              `${this.config.botName}[bot]`,
              "diffsentry[bot]",
            ],
            topN: 3,
          });
        } catch (err) {
          log.debug({ err }, "Blame-based reviewer suggestion failed");
        }
      }

      // CODEOWNERS-aware reviewer routing
      let codeownersOwners: Awaited<ReturnType<typeof ownersForFiles>> = [];
      try {
        const rules = await loadCodeowners(octokit, owner, repo, context.headSha);
        codeownersOwners = ownersForFiles(rules, context.files.map((f) => f.filename), [
          context.author ?? "",
          this.config.botName,
          `${this.config.botName}[bot]`,
        ]);
      } catch (err) {
        log.debug({ err }, "CODEOWNERS load failed");
      }

      // Cross-PR thread memory — find prior bot inline comments on the
      // same paths so we can link them under each new finding.
      let priorByPath: Map<string, Awaited<ReturnType<typeof findPriorBotThreadsForPaths>>> | Awaited<ReturnType<typeof findPriorBotThreadsForPaths>> = new Map();
      try {
        priorByPath = await findPriorBotThreadsForPaths({
          octokit,
          owner,
          repo,
          currentPrNumber: pullNumber,
          paths: context.files.map((f) => f.filename),
          botLogin: `${this.config.botName}[bot]`,
          maxPerPath: 3,
          scanLastN: 25,
        });
      } catch (err) {
        log.debug({ err }, "Cross-PR memory lookup failed");
      }

      // Append prior-discussions footer to each AI/safety/pattern finding
      if (priorByPath instanceof Map && priorByPath.size > 0) {
        for (const c of reviewResult.comments) {
          const tail = renderPriorDiscussionsBlock(c.path, c.line, priorByPath as Map<string, any>);
          if (tail) c.body = c.body + tail;
        }
      }

      // Reviewer-delta block: which non-bot reviewers' work has been
      // invalidated by the latest changes to the files they reviewed.
      let reviewerDeltas: ReturnType<typeof computeReviewerDeltas> = [];
      try {
        const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber });
        const lastByLogin = new Map<string, string>();
        for (const r of reviews.data) {
          if (!r.user || !r.submitted_at) continue;
          if (r.user.type === "Bot") continue;
          lastByLogin.set(r.user.login, r.submitted_at);
        }
        const reviewerLastReviewed = Array.from(lastByLogin.entries()).map(([login, submittedAt]) => ({ login, submittedAt }));

        // For each file, find latest commit timestamp that modified it (within this PR)
        const prCommits = await octokit.paginate(octokit.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 });
        const latestCommitByFile = new Map<string, string>();
        for (const commit of prCommits) {
          const ts = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? "";
          if (!ts) continue;
          try {
            const detail = await octokit.repos.getCommit({ owner, repo, ref: commit.sha });
            for (const f of detail.data.files ?? []) {
              const prev = latestCommitByFile.get(f.filename);
              if (!prev || new Date(ts).getTime() > new Date(prev).getTime()) {
                latestCommitByFile.set(f.filename, ts);
              }
            }
          } catch {
            // skip
          }
        }
        const fileMeta = context.files.map((f) => ({ filename: f.filename, latestCommitAt: latestCommitByFile.get(f.filename) }));
        reviewerDeltas = computeReviewerDeltas({
          reviewerLastReviewed,
          files: fileMeta,
          excludeBots: true,
        });
      } catch (err) {
        log.debug({ err }, "Reviewer-delta computation failed");
      }

      // Post walkthrough comment
      if (walkthroughResult && walkthroughEnabled) {
        const walkthroughConfig = repoConfig.reviews?.walkthrough || {};
        let inner = formatWalkthroughInner(walkthroughResult, walkthroughConfig);

        // Insight blocks inside the walkthrough collapse
        inner += "\n\n" + renderRiskBlock(risk);
        const covBlock = renderCoverageBlock(coverage);
        if (covBlock) inner += "\n\n" + covBlock;
        const depBlock = renderDepBlock(depDeltas);
        if (depBlock) inner += "\n\n" + depBlock;
        const driftBlock = renderDriftBlock(driftFindings);
        if (driftBlock) inner += "\n\n" + driftBlock;
        const coachBlock = renderCommitCoachBlock(commitFindings);
        if (coachBlock) inner += "\n\n" + coachBlock;
        const titleFinding = reviewPRTitle(context.title);
        const titleBlock = renderTitleCoachBlock(context.title, titleFinding);
        if (titleBlock) inner += "\n\n" + titleBlock;
        const licenseOffenders = scanLicenseHeaders(context.files, repoConfig.reviews?.license_header);
        const licenseBlock = renderLicenseHeaderBlock(
          licenseOffenders,
          repoConfig.reviews?.license_header?.required ?? "",
        );
        if (licenseBlock) inner += "\n\n" + licenseBlock;
        // Single ranked Suggested Reviewers block: blame weight + CODEOWNERS,
        // each row tagged with its source(s). Falls back to the blame-only
        // renderer when CODEOWNERS isn't present.
        const combined = combineReviewers(blameReviewers, codeownersOwners, 5);
        const reviewersBlock = combined.length > 0
          ? renderCombinedReviewers(combined)
          : renderSuggestedReviewers(blameReviewers);
        if (reviewersBlock) inner += "\n\n" + reviewersBlock;
        const deltaBlock = renderReviewerDeltaBlock(reviewerDeltas);
        if (deltaBlock) inner += "\n\n" + deltaBlock;
        const confBlock = renderConfidenceAggregate(reviewResult);
        if (confBlock) inner += "\n\n" + confBlock;

        // PR splitting heuristic
        const cohorts = walkthroughResult.cohorts ?? [];
        const totalLines = context.files.reduce((s, f) => s + f.additions + f.deletions, 0);
        if (
          cohorts.length > 0 &&
          shouldSuggestSplit({
            cohortCount: cohorts.length,
            effortEstimate: walkthroughResult.effortEstimate,
            fileCount: context.files.length,
            totalChangedLines: totalLines,
          })
        ) {
          inner += "\n\n" + renderSplitSuggestion(cohorts);
        }

        // Append related PRs and linked issues inside the walkthrough collapse
        if (relatedPRsSection) inner += relatedPRsSection;
        if (linkedIssues.length > 0) {
          inner += "\n\n" + formatIssuesForWalkthrough(linkedIssues);
        }

        const wrapped = wrapWalkthroughCollapse(inner, walkthroughConfig.collapse !== false);

        let walkthroughBody =
          WALKTHROUGH_MARKER + "\n" + WALKTHROUGH_START + "\n\n" + wrapped + "\n\n" + WALKTHROUGH_END;

        // Pre-merge checks block as sibling <details>
        if (preMergeBlock) {
          walkthroughBody +=
            "\n\n<!-- pre_merge_checks_walkthrough_start -->\n\n" +
            preMergeBlock +
            "\n\n<!-- pre_merge_checks_walkthrough_end -->";
        }

        // Finishing touches checkboxes
        walkthroughBody +=
          "\n\n<!-- finishing_touch_checkbox_start -->\n\n" +
          finishingTouchesBlock() +
          "\n\n<!-- finishing_touch_checkbox_end -->";

        // Tips footer
        walkthroughBody +=
          "\n\n<!-- tips_start -->" + tipsFooter(this.config.botName) + "\n\n<!-- tips_end -->";

        // Internal state blob (base64(gzip(JSON))) for incremental review.
        const riskHistory = (priorState?.riskHistory ?? []).slice(-19);
        riskHistory.push(risk.score);
        const newState: WalkthroughState = {
          v: 1,
          lastReviewedSha: context.headSha,
          fileShas: { ...(priorState?.fileShas ?? {}), ...currentFileShas },
          postedFingerprints: Array.from(
            new Set([
              ...(priorState?.postedFingerprints ?? []),
              ...reviewResult.comments.map((c) => c.fingerprint).filter((x): x is string => !!x),
            ]),
          ),
          filesProcessed: context.files.map((f) => f.filename),
          filesSkippedSimilar,
          filesSkippedTrivial,
          updatedAt: new Date().toISOString(),
          riskHistory,
        };
        walkthroughBody +=
          "\n\n<!-- internal_state_start -->\n" + encodeState(newState) + "\n<!-- internal_state_end -->";

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

      // Pre-merge commit status (separate context from main DiffSentry status)
      if (preMergeStatus && repoConfig.reviews?.commit_status !== false) {
        const statusMap = { pass: "success" as const, warning: "success" as const, fail: "failure" as const };
        await this.github.setCommitStatus(
          installationId, owner, repo, context.headSha,
          statusMap[preMergeStatus],
          preMergeStatus === "fail" ? "Pre-merge checks failed" : "Pre-merge checks passed",
          "DiffSentry / Pre-Merge"
        ).catch(() => {});
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
      const hasYaml = rawConfig && Object.keys(rawConfig).length > 0;
      reviewResult.summary = formatReviewBody(reviewResult, {
        profile: repoConfig.reviews?.profile ?? "chill",
        owner,
        repo,
        baseSha: undefined,
        headSha: context.headSha,
        baseBranch: context.baseBranch,
        headBranch: context.headBranch,
        filesProcessed: context.files.map((f) => f.filename),
        filesIgnoredByPathFilter,
        filesNoReviewableChanges,
        filesSkippedSimilar,
        filesSkippedTrivial,
        incrementalFromSha:
          mode === "incremental" && priorState?.lastReviewedSha
            ? priorState.lastReviewedSha
            : undefined,
        configUsed: hasYaml ? "`.diffsentry.yaml`" : "defaults",
        plan: undefined,
        botName: this.config.botName,
      });

      // Filter out review comments whose fingerprint was already posted
      // (cross-review dedup). Anthropic + state survive bot restarts.
      if (priorFingerprints.size > 0) {
        reviewResult.comments = reviewResult.comments.filter((c) => {
          const fp = c.fingerprint;
          if (fp && priorFingerprints.has(fp)) {
            log.debug({ fp, path: c.path, line: c.line }, "Dropping previously-posted comment");
            return false;
          }
          return true;
        });
      }

      // Persist this review to SQLite (best-effort; no-op if DB disabled).
      // Done before GitHub submission so an API failure doesn't lose the data.
      recordRepo({ owner, repo, installationId });
      recordPR(context, { state: "open" });
      const reviewId = recordReview({
        ctx: context,
        result: reviewResult,
        risk,
        profile: repoConfig.reviews?.profile ?? "chill",
        filesProcessed: context.files.length,
        filesSkippedSimilar: filesSkippedSimilar.length,
        filesSkippedTrivial: filesSkippedTrivial.length,
      });
      if (reviewId !== null) {
        recordFindings(reviewId, reviewResult.comments, (c) => {
          // Tag source by which producer emitted the finding. Safety-scanner
          // findings carry "security"/"issue" + "critical" for secrets/markers,
          // and have a fingerprint shape we already use; pattern-checks produce
          // anti-pattern findings. Map heuristically — close enough for the
          // dashboard's source filter.
          if (c.fingerprint && c.body?.includes("DiffSentry's safety scanner")) return "safety";
          if (c.body?.includes("DiffSentry built-in pattern check")) return "builtin";
          if (c.body?.includes("Project anti-pattern")) return "custom";
          return "ai";
        });
        recordPatternHits({
          owner,
          repo,
          reviewId,
          hits: [
            ...safetyFindings.map((f) => ({ ruleName: f.title ?? "safety", source: "safety" as const, fingerprint: f.fingerprint })),
            ...patternFindings.map((f) => ({
              ruleName: f.title ?? "pattern",
              source: (f.body?.includes("Project anti-pattern") ? "custom" : "builtin") as "builtin" | "custom",
              fingerprint: f.fingerprint,
            })),
          ],
        });
      }

      // Submit the code review
      log.info(
        { commentCount: reviewResult.comments.length, approval: reviewResult.approval },
        "Review complete, submitting to GitHub"
      );
      await this.github.submitReview(installationId, context, reviewResult);

      // Upsert the sticky pinned status comment (separate from the
      // walkthrough — short, scannable snapshot of current PR state).
      try {
        let unresolvedThreads = 0;
        let failingChecks = 0;
        let pendingChecks = 0;
        try {
          const q = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { isResolved } } } } }`;
          const r: any = await octokit.graphql(q, { owner, repo, pr: pullNumber });
          unresolvedThreads = (r?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length;
        } catch {
          // best effort
        }
        try {
          const s = await octokit.repos.getCombinedStatusForRef({ owner, repo, ref: context.headSha });
          for (const st of s.data.statuses) {
            if (st.state === "failure" || st.state === "error") failingChecks++;
            else if (st.state === "pending") pendingChecks++;
          }
        } catch {
          // best effort
        }
        const stickyBody = renderStickyStatus({
          reviewState: reviewResult.approval as any,
          risk,
          unresolvedThreads,
          failingChecks,
          pendingChecks,
          filesProcessed: context.files.length,
          filesSkipped: filesSkippedSimilar.length + filesSkippedTrivial.length,
          lastReviewedAt: new Date().toISOString().replace("T", " ").slice(0, 16) + "Z",
          lastReviewedSha: context.headSha,
          owner,
          repo,
          botName: this.config.botName,
          riskHistory: (priorState?.riskHistory ?? []).concat(risk.score).slice(-20),
        });
        await this.github.upsertComment(installationId, owner, repo, pullNumber, stickyBody, STICKY_MARKER);
      } catch (err) {
        log.warn({ err }, "Failed to upsert sticky status comment");
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
    commentId: number,
    commentKind: "issue" | "review_thread" = "issue"
  ): Promise<void> {
    const log = logger.child({ owner, repo, pr: pullNumber, commentId, commentKind });
    const key = prKey(owner, repo, pullNumber);

    const command = parseCommand(commentBody, this.config.botName);
    if (!command) {
      log.debug("No command found in comment");
      return;
    }

    log.info({ commandType: command.type }, "Processing command");

    // Local helper so every reply in this handler lands in the right place
    // (inside the review thread when the trigger came from one, otherwise
    // as a top-level issue comment).
    const reply = (body: string): Promise<void> =>
      this.github.replyToComment(installationId, owner, repo, pullNumber, commentId, body, commentKind);

    try {
      switch (command.type) {
        case "help": {
          const helpText = formatHelpMessage(this.config.botName);
          await reply( helpText);
          break;
        }

        case "review": {
          await reply(
            actionsPerformed("Review triggered.", "DiffSentry is an incremental review system and does not re-review already reviewed commits."),
          );
          await this.handlePullRequest(installationId, owner, repo, pullNumber, "incremental");
          break;
        }

        case "full_review": {
          await reply(
            actionsPerformed("Full review triggered."),
          );
          await this.handlePullRequest(installationId, owner, repo, pullNumber, "full");
          break;
        }

        case "pause": {
          pausedPRs.add(key);
          await reply(
            pauseNotice(this.config.botName, "manual"),
          );
          break;
        }

        case "resume": {
          pausedPRs.delete(key);
          reviewCountByPR.delete(key); // Reset count on resume
          await reply(
            resumeNotice(),
          );
          break;
        }

        case "resolve": {
          await this.github.resolveAllComments(installationId, owner, repo, pullNumber);
          await reply(
            actionsPerformed("All review comment threads marked as resolved."),
          );
          break;
        }

        case "summary": {
          await reply(
            "Regenerating summary..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
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
          const ctxForCfg = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, ctxForCfg.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const configMsg = formatConfigMessage(repoConfig, {
            aiProvider: this.config.aiProvider,
            maxFilesPerReview: this.config.maxFilesPerReview,
            botName: this.config.botName,
          });
          await reply( configMsg);
          break;
        }

        case "learn": {
          const repoFullName = `${owner}/${repo}`;
          await this.learnings.addLearning(repoFullName, command.content);
          await reply(
            actionsPerformed(
              `Learning saved. I'll apply this in future reviews of **${owner}/${repo}**.\n\n> ${command.content}`,
            ),
          );
          break;
        }

        case "generate_docstrings": {
          await reply(
            "Generating docstrings for changed files..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await generateDocstrings(octokit, context, this.ai);
          await reply(
            result.filesChanged > 0
              ? `Added docstrings to ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No files needed docstring updates."
          );
          break;
        }

        case "generate_tests": {
          await reply(
            "Generating unit tests for changed files..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await generateTests(octokit, context, this.ai);
          await reply(
            result.filesChanged > 0
              ? `Generated tests in ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "Could not generate tests for these changes."
          );
          break;
        }

        case "simplify": {
          await reply(
            "Analyzing changed code for simplification opportunities..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await simplifyCode(octokit, context, this.ai);
          await reply(
            result.filesChanged > 0
              ? `Simplified ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No simplification opportunities found."
          );
          break;
        }

        case "autofix": {
          await reply(
            "Applying fixes from review comments..."
          );
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const result = await autofix(octokit, context, this.ai);
          await reply(
            result.filesChanged > 0
              ? `Applied fixes to ${result.filesChanged} file(s). Commit: \`${result.commitSha?.slice(0, 7)}\``
              : "No actionable fixes found in review comments."
          );
          break;
        }

        case "bench": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `Identify the single most performance-sensitive function added or modified in this PR. Then write a self-contained micro-benchmark for it.

Output exactly:
1. A one-paragraph rationale: which function and why it's perf-sensitive.
2. A code block (with language fence) containing a complete benchmark file the user can drop into their repo. Use vitest's \`bench\` API for TS/JS, \`go test -bench\` for Go, \`pytest-benchmark\` for Python, or the idiomatic equivalent for the file's language.
3. A one-line note on how to run it.

Skip the benchmark code if no changed function is plausibly perf-sensitive — say so instead.`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 🧪 Bench\n\n${response.trim()}\n\n<sub>Generated by DiffSentry on demand. Re-run with \`@${this.config.botName} bench\`.</sub>`,
          );
          break;
        }

        case "changelog": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `Write a CHANGELOG.md entry for this PR in the Keep-a-Changelog format. Output a single Markdown code block:

\`\`\`markdown
### Added
- ...
### Changed
- ...
### Fixed
- ...
### Removed
- ...
\`\`\`

Only include sections that have entries. Each bullet is one short past-tense sentence describing user-visible impact (not internal refactors). End with the PR number on the last bullet of each section as \`(#${pullNumber})\` if relevant.`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 📓 Changelog Entry\n\n${response.trim()}\n\n<sub>Drop into your CHANGELOG.md. Re-run with \`@${this.config.botName} changelog\`.</sub>`,
          );
          break;
        }

        case "release_notes": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `Write public release notes for this PR. Audience: end users / customers, not engineers.

Format:

### ✨ What's new
<2-3 bullets of user-visible improvements in plain English. Lead with the benefit, not the implementation.>

### 🛠 Improvements
<bullets — performance, reliability, polish>

### 🐛 Fixes
<bullets — only include when there are real fixes>

### 💔 Breaking changes
<only when actually breaking; otherwise omit the section>

Skip sections with no content. No code blocks, no acronyms without expansion, no internal jargon ("refactored", "unblocked", "leveraged").`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 📣 Release Notes\n\n${response.trim()}\n\n<sub>Marketing-speak version of this PR. Re-run with \`@${this.config.botName} release-notes\`.</sub>`,
          );
          break;
        }

        case "diff_pr": {
          const targetNum = parseInt(command.target.replace(/^#/, "").trim(), 10);
          if (!Number.isFinite(targetNum) || targetNum <= 0) {
            await reply(
              `Couldn't parse a PR number from \`${command.target}\`. Try \`@${this.config.botName} diff 42\`.`,
            );
            break;
          }
          const octokit = await this.github.getInstallationOctokit(installationId);
          try {
            const result = await diffWithOtherPR({
              octokit, owner, repo, thisPrNumber: pullNumber, otherPrNumber: targetNum,
            });
            await reply(
              renderDiffPRReply(pullNumber, result, this.config.botName),
            );
          } catch (err: any) {
            await reply(
              `Couldn't compare with #${targetNum}: ${err?.message ?? "unknown error"}.`,
            );
          }
          break;
        }

        case "rewrite_description": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `Propose a clearer replacement for this PR's title and description.

Output ONLY valid JSON (no fences, no prose):
{
  "title": "Imperative-mood title under 72 chars, no trailing period",
  "body": "Multi-paragraph Markdown body. Lead with WHAT, then WHY, then any caveats. Reference filenames in backticks. Include a short bulleted list of changes if it helps."
}`;
          const raw = await this.ai.chat(context, ask, repoConfig);
          const cleaned = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          let proposal: { title?: string; body?: string } = {};
          try {
            proposal = JSON.parse(cleaned);
          } catch {
            await reply(
              `Couldn't parse a rewrite from the AI response. Try again, or paste the desired text yourself.`,
            );
            break;
          }
          const newTitle = (proposal.title ?? "").trim();
          const newBody = (proposal.body ?? "").trim();
          if (!newTitle || !newBody) {
            await reply(
              `AI returned an empty title or body — declining to apply.`,
            );
            break;
          }
          try {
            await octokit.pulls.update({ owner, repo, pull_number: pullNumber, title: newTitle, body: newBody });
            await reply(
              `<details>\n<summary>✅ Actions performed</summary>\n\nApplied AI-rewritten title + description.\n\n**New title:** ${newTitle}\n\n</details>\n\n<!-- This is an auto-generated reply by DiffSentry -->`,
            );
          } catch (err: any) {
            await reply(
              `Couldn't apply the rewrite: ${err?.message ?? "unknown error"}.`,
            );
          }
          break;
        }

        case "chat": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const response = await this.ai.chat(context, command.message, repoConfig);
          await reply(response);

          // If the user replied inside a bot-started review thread, ask the AI
          // whether the exchange resolves the original suggestion (either by
          // acknowledging it as a false positive or by explaining it's already
          // addressed). If yes, mark the thread resolved.
          if (commentKind === "review_thread") {
            try {
              const thread = await this.github.findThreadByCommentId(
                installationId, owner, repo, pullNumber, commentId
              );
              if (thread && !thread.isResolved) {
                const judgePrompt = [
                  "You are judging whether a review-thread exchange resolves the bot's original suggestion.",
                  "Reply with EXACTLY one token: YES or NO. No explanation, no punctuation.",
                  "",
                  "Resolve (YES) when the human credibly explains why the suggestion is unnecessary, a false positive, ",
                  "out of scope, or already handled — AND the bot's reply agrees / acknowledges / verifies that.",
                  "Do NOT resolve (NO) if the bot pushes back, asks for more info, or the human is just asking a question.",
                  "",
                  "## Original bot suggestion",
                  thread.originalBody || "(unavailable)",
                  "",
                  "## Human reply",
                  command.message,
                  "",
                  "## Bot reply",
                  response,
                ].join("\n");
                const verdict = (await this.ai.chat(context, judgePrompt, repoConfig)).trim().toUpperCase();
                if (verdict.startsWith("YES")) {
                  const ok = await this.github.resolveThreadById(
                    installationId, owner, repo, pullNumber, thread.threadId
                  );
                  if (ok) log.info({ threadId: thread.threadId }, "Auto-resolved thread after acknowledged reply");
                } else {
                  log.debug({ verdict }, "Judge declined to resolve thread");
                }
              }
            } catch (err) {
              log.warn({ err }, "Thread-reply auto-resolve failed");
            }
          }
          break;
        }

        case "tldr": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask =
            "Write a single plain-English paragraph (3-5 sentences max) describing this PR. " +
            "Lead with WHAT it does, then WHY, then any one notable caveat. " +
            "No headings, no bullet lists, no code blocks. Conversational tone for a busy reviewer.";
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `## TL;DR\n\n${response.trim()}\n\n<sub>Generated by DiffSentry on demand. Re-run with \`@${this.config.botName} tldr\`.</sub>`,
          );
          break;
        }

        case "tour": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `You are guiding a reviewer through this PR file by file in the order they should read.

For each changed file (most important first), output one Markdown section:

### N. \`path/to/file\`
**Why this first:** <one sentence>
**What to look at:** <1-3 sentences pointing to specific lines/symbols>

After the per-file sections, end with a **"## Final Check"** section: 1-3 cross-cutting things to verify after reading every file.

Order by priority for review (highest-risk / load-bearing first), not alphabetically.`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 🗺️ Code Tour\n\n${response.trim()}\n\n<sub>Suggested reading order from DiffSentry. Re-run with \`@${this.config.botName} tour\`.</sub>`,
          );
          break;
        }

        case "ship": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);

          // Fetch live state across surfaces in parallel
          const [reviews, prComments, statusResp, ownerRules] = await Promise.all([
            octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber }),
            octokit.pulls.listReviewComments({ owner, repo, pull_number: pullNumber, per_page: 100 }),
            octokit.repos.getCombinedStatusForRef({ owner, repo, ref: context.headSha }).catch(() => null as any),
            loadCodeowners(octokit, owner, repo, context.headSha).catch(() => []),
          ]);

          // Latest bot review state
          const latestBotReview = [...reviews.data]
            .reverse()
            .find((r) => r.user?.type === "Bot" && r.user?.login?.toLowerCase().startsWith(this.config.botName.toLowerCase()));
          const reviewState = latestBotReview?.state ?? "PENDING";

          // Open inline threads via GraphQL
          let unresolvedThreads = 0;
          try {
            const q = `
              query($owner: String!, $repo: String!, $pr: Int!) {
                repository(owner: $owner, name: $repo) {
                  pullRequest(number: $pr) {
                    reviewThreads(first: 100) { nodes { isResolved } }
                  }
                }
              }`;
            const r: any = await octokit.graphql(q, { owner, repo, pr: pullNumber });
            unresolvedThreads = (r?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter((t: any) => !t.isResolved).length;
          } catch {
            // best effort
          }

          const statuses = (statusResp?.data?.statuses ?? []) as Array<{ context: string; state: string; description?: string | null }>;
          const failingChecks = statuses.filter((s) => s.state === "failure" || s.state === "error");
          const pendingChecks = statuses.filter((s) => s.state === "pending");

          const blockers: string[] = [];
          const warnings: string[] = [];
          if (reviewState === "CHANGES_REQUESTED") blockers.push("DiffSentry has requested changes (latest review).");
          if (unresolvedThreads > 0) warnings.push(`${unresolvedThreads} unresolved review thread${unresolvedThreads === 1 ? "" : "s"}.`);
          if (failingChecks.length > 0) blockers.push(`${failingChecks.length} failing commit status check${failingChecks.length === 1 ? "" : "s"}: ${failingChecks.map((s) => `\`${s.context}\``).join(", ")}.`);
          if (pendingChecks.length > 0) warnings.push(`${pendingChecks.length} pending check${pendingChecks.length === 1 ? "" : "s"}: ${pendingChecks.map((s) => `\`${s.context}\``).join(", ")}.`);

          // CODEOWNERS gate: if the repo has a CODEOWNERS file and any of
          // the touched files have owners, require at least one APPROVED
          // human review from a matching owner before clearing the gate.
          if (ownerRules.length > 0) {
            const owners = ownersForFiles(ownerRules, context.files.map((f) => f.filename), [
              context.author ?? "",
              this.config.botName,
              `${this.config.botName}[bot]`,
            ]);
            if (owners.length > 0) {
              const ownerSet = new Set(owners.map((o) => o.login.toLowerCase()));
              const ownerApprovals = reviews.data
                .filter((r) => r.state === "APPROVED" && r.user?.login)
                .map((r) => r.user!.login.toLowerCase())
                .filter((login) => ownerSet.has(login));
              if (ownerApprovals.length === 0) {
                blockers.push(
                  `No CODEOWNERS approval yet — needs review from one of: ${owners
                    .slice(0, 5)
                    .map((o) => `@${o.login}`)
                    .join(", ")}.`,
                );
              }
            }
          }

          const verdict =
            blockers.length === 0
              ? warnings.length === 0
                ? "🟢 **Ready to ship.** All blockers clear, no warnings."
                : "🟡 **Probably safe to ship**, but address the warnings first."
              : "🔴 **Not ready.** Address the blockers below before merging.";

          const lines: string[] = [];
          lines.push(`# 🚀 Ship Check`);
          lines.push("");
          lines.push(verdict);
          lines.push("");
          lines.push(`| Surface | Status |`);
          lines.push(`|---|---|`);
          lines.push(`| DiffSentry review | \`${reviewState}\` |`);
          lines.push(`| Unresolved review threads | ${unresolvedThreads} |`);
          lines.push(`| Failing commit statuses | ${failingChecks.length} |`);
          lines.push(`| Pending commit statuses | ${pendingChecks.length} |`);

          if (blockers.length > 0) {
            lines.push("");
            lines.push("## Blockers");
            blockers.forEach((b) => lines.push(`- ❌ ${b}`));
          }
          if (warnings.length > 0) {
            lines.push("");
            lines.push("## Warnings");
            warnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
          }

          await reply(
            lines.join("\n") + `\n\n<sub>Re-run with \`@${this.config.botName} ship\` after addressing.</sub>`,
          );
          break;
        }

        case "rubber_duck": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `You are a Socratic rubber-duck reviewer. Pick the 3 most consequential design choices in this PR — one per section. For each, do NOT advocate or judge. Instead, ask 1-2 sharp questions that force the author to defend or reconsider the choice. End with one open-ended question about an aspect that wasn't addressed at all.

Format:

### 🦆 Question 1: <topic in 5-8 words>
> <The question itself, in italics or as a blockquote.>
**What this is probing:** <One sentence on what answer would resolve the doubt.>

### 🦆 Question 2: <topic>
...

### 🦆 Question 3: <topic>
...

### 🦆 The unasked question
> <Open-ended question about something the PR doesn't address but should.>`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 🦆 Rubber Duck\n\nPretend I'm a rubber duck. Walk me through your reasoning on these:\n\n${response.trim()}\n\n<sub>Socratic-mode review by DiffSentry. Re-run with \`@${this.config.botName} rubber-duck\`.</sub>`,
          );
          break;
        }

        case "timeline": {
          const octokit = await this.github.getInstallationOctokit(installationId);
          // Fetch the surfaces in parallel
          const [commits, reviews, issueComments, prComments, statusResp, prData] =
            await Promise.all([
              octokit.paginate(octokit.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 }),
              octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber }),
              octokit.paginate(octokit.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
              octokit.paginate(octokit.pulls.listReviewComments, { owner, repo, pull_number: pullNumber, per_page: 100 }),
              octokit.repos.getCombinedStatusForRef({ owner, repo, ref: (await octokit.pulls.get({ owner, repo, pull_number: pullNumber })).data.head.sha }).catch(() => null as any),
              octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
            ]);

          type Event = { ts: string; icon: string; line: string };
          const events: Event[] = [];

          events.push({
            ts: prData.data.created_at,
            icon: "🟦",
            line: `PR opened by **${prData.data.user?.login ?? "unknown"}**: _${prData.data.title}_`,
          });

          for (const c of commits) {
            const ts = c.commit?.author?.date ?? c.commit?.committer?.date ?? "";
            const subject = (c.commit?.message ?? "").split("\n")[0];
            events.push({
              ts: ts || prData.data.created_at,
              icon: "🟢",
              line: `Commit \`${c.sha.slice(0, 7)}\` by **${c.commit?.author?.name ?? "?"}**: ${subject}`,
            });
          }

          for (const r of reviews.data) {
            const ts = r.submitted_at ?? "";
            const who = r.user?.login ?? "?";
            const stateIcon = r.state === "APPROVED" ? "✅" : r.state === "CHANGES_REQUESTED" ? "❌" : "💬";
            events.push({ ts, icon: stateIcon, line: `Review **${r.state}** by @${who}` });
          }

          for (const c of issueComments) {
            if (!c.user) continue;
            if (c.user.login?.toLowerCase().includes(this.config.botName.toLowerCase())) continue;
            const summary = (c.body ?? "").split("\n")[0].slice(0, 80);
            events.push({ ts: c.created_at, icon: "💬", line: `Comment by @${c.user.login}: _${summary}_` });
          }

          for (const c of prComments) {
            if (!c.user) continue;
            if (c.user.login?.toLowerCase().includes(this.config.botName.toLowerCase())) continue;
            events.push({
              ts: c.created_at,
              icon: "🔍",
              line: `Inline comment by @${c.user.login} on \`${c.path}:${c.line ?? c.original_line ?? "?"}\``,
            });
          }

          if (prData.data.merged_at) {
            events.push({ ts: prData.data.merged_at, icon: "🟣", line: `Merged by **${prData.data.merged_by?.login ?? "?"}**` });
          } else if (prData.data.closed_at) {
            events.push({ ts: prData.data.closed_at, icon: "⚫", line: `Closed without merge` });
          }

          for (const s of statusResp?.data?.statuses ?? []) {
            const stateIcon = s.state === "success" ? "✅" : s.state === "failure" ? "❌" : s.state === "pending" ? "⏳" : "⚠️";
            events.push({
              ts: s.updated_at ?? "",
              icon: stateIcon,
              line: `Status \`${s.context}\` → **${s.state}**${s.description ? ` — ${s.description}` : ""}`,
            });
          }

          events.sort((a, b) => a.ts.localeCompare(b.ts));

          const lines: string[] = [];
          lines.push(`# 🕒 PR Timeline`);
          lines.push("");
          for (const e of events) {
            const t = e.ts ? new Date(e.ts).toISOString().replace("T", " ").slice(0, 16) + "Z" : "?";
            lines.push(`- \`${t}\` ${e.icon} ${e.line}`);
          }
          lines.push("");
          lines.push(`<sub>${events.length} event(s) reconstructed from GitHub. Re-run with \`@${this.config.botName} timeline\`.</sub>`);

          await reply( lines.join("\n"));
          break;
        }

        case "eli5": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const ask = `Explain this PR as if the reader is intelligent but unfamiliar with the codebase, the language, and the domain. Audience: a stakeholder, designer, or cross-team engineer.

Format:

### What this PR is about
<2-3 plain-English sentences. Use analogies. No jargon.>

### What changes for users / the system
<1-2 sentences on observable impact.>

### Why this approach
<1-2 sentences on the choice. Compare to the obvious alternative.>

### What could still go wrong
<1-2 sentences naming a real risk in plain language.>

Hard rules: no code blocks, no acronyms without expansion, no "leverage"/"utilize"/"orchestrate" jargon. Short sentences.`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 🧒 ELI5\n\n${response.trim()}\n\n<sub>Plain-English mode by DiffSentry. Re-run with \`@${this.config.botName} eli5\`.</sub>`,
          );
          break;
        }

        case "five_why": {
          const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);
          const octokit = await this.github.getInstallationOctokit(installationId);
          const rawConfig = await loadRepoConfig(octokit, owner, repo, context.headSha);
          const repoConfig = mergeWithDefaults(rawConfig);
          const target = command.target.trim() || "the most consequential change in this PR";
          const ask = `Apply the Toyota 5-Whys technique to: **${target}**.

Output exactly 5 levels, each one a "Why?" deeper than the last:

**Why 1?** <observation>
- <reasoning>

**Why 2?** <one-level-deeper question>
- <reasoning>

**Why 3?** ...
**Why 4?** ...
**Why 5?** <root-cause hypothesis>

After Why 5, write a single paragraph **"## Root cause"** stating the structural issue or design pressure that shaped the change. Be specific to this PR and codebase, not generic advice.`;
          const response = await this.ai.chat(context, ask, repoConfig);
          await reply(
            `# 🤔 Five Whys: ${target}\n\n${response.trim()}\n\n<sub>Re-run with \`@${this.config.botName} 5why <target>\`.</sub>`,
          );
          break;
        }
      }
    } catch (err) {
      log.error({ err, commandType: command.type }, "Command handling failed");
      try {
        await reply(
          "Sorry, I encountered an error processing your request. Please try again."
        );
      } catch {
        // Give up on error reporting
      }
    }
  }
}
