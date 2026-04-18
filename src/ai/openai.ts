import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
import { logger } from "../logger.js";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
    this.model = model;
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending review request to OpenAI");

    const tokenParam = this.model.startsWith("o") ? "max_completion_tokens" : "max_tokens";

    const response = await this.client.chat.completions.create({
      model: this.model,
      [tokenParam]: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content || "";

    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI review response received"
    );

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending walkthrough request to OpenAI");

    const tokenParam = this.model.startsWith("o") ? "max_completion_tokens" : "max_tokens";

    const response = await this.client.chat.completions.create({
      model: this.model,
      [tokenParam]: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const text = response.choices[0]?.message?.content || "";

    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI walkthrough response received"
    );

    return parseWalkthroughResponse(text);
  }

  async chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildChatPrompt(context, userMessage);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending chat request to OpenAI");

    const tokenParam = this.model.startsWith("o") ? "max_completion_tokens" : "max_tokens";

    const response = await this.client.chat.completions.create({
      model: this.model,
      [tokenParam]: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const text = response.choices[0]?.message?.content || "";

    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI chat response received"
    );

    return text;
  }
}
