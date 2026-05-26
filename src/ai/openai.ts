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

  /** o-series and gpt-5+ are reasoning models — `max_completion_tokens` is
   *  the combined budget for hidden chain-of-thought AND visible output. */
  private get isReasoningModel(): boolean {
    const m = this.model.toLowerCase();
    if (m.startsWith("o")) return true;
    const gpt = m.match(/^gpt-(\d+)/);
    return !!(gpt && Number(gpt[1]) >= 5);
  }

  private get tokenParam(): "max_completion_tokens" | "max_tokens" {
    return this.isReasoningModel ? "max_completion_tokens" : "max_tokens";
  }

  /** Reasoning models split this budget between hidden CoT and visible
   *  output. The previous 4096-token review budget regularly burned out
   *  on reasoning alone, leaving `message.content` empty. These ceilings
   *  give reasoning headroom even with `reasoning_effort: "minimal"`. */
  private tokenBudgetFor(task: "review" | "walkthrough" | "chat" | "complete"): number {
    if (!this.isReasoningModel) {
      if (task === "complete") return 512;
      return task === "chat" ? 2048 : 4096;
    }
    switch (task) {
      case "review":
      case "walkthrough":
        return 16384;
      case "chat":
        return 8192;
      case "complete":
        return 4096;
    }
  }

  /** For JSON-output tasks the model's hidden reasoning rarely improves
   *  quality but routinely starves the visible output of tokens. Force
   *  minimal reasoning on these paths. SDK 4.85 doesn't type "minimal"
   *  yet, so we spread it in via a cast. The API accepts it for gpt-5+. */
  private structuredOutputExtras(): Record<string, unknown> {
    return this.isReasoningModel ? { reasoning_effort: "minimal" } : {};
  }

  /** When OpenAI returns empty content with `finish_reason: "length"`, the
   *  request hit the token cap before any visible output was emitted —
   *  almost always a reasoning model burning the whole budget on hidden
   *  CoT. Log loudly so this is debuggable from the server logs. */
  private logEmptyCompletion(
    log: { warn: (obj: object, msg: string) => void },
    response: OpenAI.Chat.ChatCompletion,
    task: string,
  ): void {
    const choice = response.choices[0];
    const text = choice?.message?.content?.trim() ?? "";
    if (text) return;
    const finishReason = choice?.finish_reason;
    const reasoningTokens = (response.usage as any)?.completion_tokens_details?.reasoning_tokens;
    log.warn(
      {
        task,
        finishReason,
        outputTokens: response.usage?.completion_tokens,
        reasoningTokens,
        isReasoningModel: this.isReasoningModel,
      },
      finishReason === "length"
        ? "OpenAI returned empty content — token budget exhausted (likely reasoning tokens). Try a smaller PR, raise the budget, or use a non-reasoning model."
        : "OpenAI returned empty content with finish_reason != length — check the prompt and model output.",
    );
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending review request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: this.tokenBudgetFor("review"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      ...this.structuredOutputExtras(),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const text = response.choices[0]?.message?.content || "";

    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        reasoningTokens: (response.usage as any)?.completion_tokens_details?.reasoning_tokens,
      },
      "OpenAI review response received"
    );
    this.logEmptyCompletion(log, response, "review");

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending walkthrough request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: this.tokenBudgetFor("walkthrough"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      ...this.structuredOutputExtras(),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const text = response.choices[0]?.message?.content || "";

    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        reasoningTokens: (response.usage as any)?.completion_tokens_details?.reasoning_tokens,
      },
      "OpenAI walkthrough response received"
    );
    this.logEmptyCompletion(log, response, "walkthrough");

    return parseWalkthroughResponse(text);
  }

  async chat(context: PRContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildChatPrompt(context, userMessage);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending chat request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: this.tokenBudgetFor("chat"),
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
        reasoningTokens: (response.usage as any)?.completion_tokens_details?.reasoning_tokens,
      },
      "OpenAI chat response received"
    );
    this.logEmptyCompletion(log, response, "chat");

    return text;
  }

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const extras = opts?.json ? this.structuredOutputExtras() : {};
    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: opts?.maxTokens ?? this.tokenBudgetFor("complete"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts?.json ? { response_format: { type: "json_object" as const } } : {}),
      ...extras,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
    return response.choices[0]?.message?.content || "";
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildIssueChatPrompt(context, userMessage, repoConfig);
    const log = logger.child({ provider: "openai", model: this.model, surface: "issue" });

    log.info("Sending issue chat request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      [this.tokenParam]: this.tokenBudgetFor("chat"),
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
        reasoningTokens: (response.usage as any)?.completion_tokens_details?.reasoning_tokens,
      },
      "OpenAI issue chat response received"
    );
    this.logEmptyCompletion(log, response, "chatIssue");

    return text;
  }
}
