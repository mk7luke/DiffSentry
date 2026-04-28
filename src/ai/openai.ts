import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning, IssueContext } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt, buildIssueChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
import { logger } from "../logger.js";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
    this.model = model;
  }

  private get tokenParam(): "max_completion_tokens" | "max_tokens" {
    const m = this.model.toLowerCase();
    if (m.startsWith("o")) return "max_completion_tokens";
    const gpt5 = m.match(/^gpt-(\d+)(?:\.(\d+))?/);
    if (gpt5) {
      const major = Number(gpt5[1]);
      if (major >= 5) return "max_completion_tokens";
    }
    return "max_tokens";
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending review request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: 4096,
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: 4096,
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: 2048,
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

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: opts?.maxTokens ?? 512,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts?.json ? { response_format: { type: "json_object" as const } } : {}),
    });
    return response.choices[0]?.message?.content || "";
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildIssueChatPrompt(context, userMessage, repoConfig);
    const log = logger.child({ provider: "openai", model: this.model, surface: "issue" });

    log.info("Sending issue chat request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: 2048,
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
      "OpenAI issue chat response received"
    );

    return text;
  }
}
