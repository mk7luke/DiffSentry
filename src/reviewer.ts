import { Config, AIProvider, PRContext } from "./types.js";
import { AnthropicProvider } from "./ai/anthropic.js";
import { OpenAIProvider } from "./ai/openai.js";
import { GitHubClient } from "./github.js";
import { logger } from "./logger.js";

export class Reviewer {
  private ai: AIProvider;
  private github: GitHubClient;

  constructor(config: Config) {
    this.github = new GitHubClient(config);

    if (config.aiProvider === "anthropic") {
      this.ai = new AnthropicProvider(config.anthropicApiKey!, config.anthropicModel);
    } else {
      this.ai = new OpenAIProvider(config.openaiApiKey!, config.openaiModel);
    }
  }

  async handlePullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    const log = logger.child({ owner, repo, pr: pullNumber });

    try {
      log.info("Fetching PR context");
      const context = await this.github.getPRContext(installationId, owner, repo, pullNumber);

      if (context.files.length === 0) {
        log.info("No reviewable files in PR, skipping");
        return;
      }

      log.info({ fileCount: context.files.length }, "Starting AI review");
      const result = await this.ai.review(context);

      log.info(
        { commentCount: result.comments.length, approval: result.approval },
        "Review complete, submitting to GitHub"
      );
      await this.github.submitReview(installationId, context, result);
    } catch (err) {
      log.error({ err }, "Review failed");
      throw err;
    }
  }
}
