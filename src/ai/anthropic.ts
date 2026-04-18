import Anthropic from "@anthropic-ai/sdk";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
import { logger } from "../logger.js";

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, ...(baseURL && { baseURL }) });
    this.model = model;
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: "anthropic", model: this.model });

    log.info("Sending review request to Anthropic");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      "Anthropic review response received"
    );

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: "anthropic", model: this.model });

    log.info("Sending walkthrough request to Anthropic");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      "Anthropic walkthrough response received"
    );

    return parseWalkthroughResponse(text);
  }

  async chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildChatPrompt(context, userMessage);
    const log = logger.child({ provider: "anthropic", model: this.model });

    log.info("Sending chat request to Anthropic");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      "Anthropic chat response received"
    );

    return text;
  }
}
