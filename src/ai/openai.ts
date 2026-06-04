import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning, IssueContext } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt, buildIssueChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
import { recordAiUsage } from "./cost.js";
import { logger } from "../logger.js";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  /** Lowest-to-highest reasoning effort. We want the lowest the model
   *  accepts so reasoning tokens don't starve visible output (see bf76968).
   *  `none` and `minimal` exist on different model families: gpt-5.0 took
   *  `minimal`, gpt-5.5+ took `none` instead, and OpenAI may keep shifting
   *  the alphabet — so we treat this list as a preference order rather
   *  than a per-model hardcode. */
  private static readonly REASONING_EFFORT_PREFERENCE = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const;

  /** Cached working `reasoning_effort` for this model, learned from a
   *  rejected request. `undefined` = use the static guess; a string =
   *  use that learned value; `null` = no value works, omit the field. */
  private learnedReasoningEffort: string | null | undefined = undefined;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
    this.model = model;
  }

  /** Record token usage + cost for one call (best-effort, never throws). */
  private track(
    usage: { prompt_tokens?: number; completion_tokens?: number } | undefined | null,
    kind: string,
  ): void {
    recordAiUsage({
      provider: "openai",
      model: this.model,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      fallbackKind: kind,
    });
  }

  /** o-series and gpt-5+ are reasoning models — `max_completion_tokens` is
   *  the combined budget for hidden chain-of-thought AND visible output. */
  private get isReasoningModel(): boolean {
    return this.isOSeries || this.isGpt5OrLater;
  }

  private get isOSeries(): boolean {
    return this.model.toLowerCase().startsWith("o");
  }

  private get isGpt5OrLater(): boolean {
    const gpt = this.model.toLowerCase().match(/^gpt-(\d+)/);
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
   *  quality but routinely starves the visible output of tokens. Push
   *  reasoning as low as the model accepts: "minimal" is gpt-5+ only,
   *  o-series tops out at "low" and rejects "minimal". Non-reasoning
   *  models get nothing — they'd reject the field outright.
   *
   *  If a previous request was rejected because the model didn't recognize
   *  our chosen value (e.g. gpt-5.5 wants "none", not "minimal"), use the
   *  value we learned from that rejection instead. */
  private structuredOutputExtras(): Record<string, unknown> {
    if (this.learnedReasoningEffort === null) return {};
    if (this.learnedReasoningEffort !== undefined) {
      return { reasoning_effort: this.learnedReasoningEffort };
    }
    if (this.isGpt5OrLater) return { reasoning_effort: "minimal" };
    if (this.isOSeries) return { reasoning_effort: "low" };
    return {};
  }

  private isUnsupportedReasoningEffortError(err: unknown): boolean {
    if (!(err instanceof OpenAI.APIError)) return false;
    if (err.status !== 400) return false;
    const detail = (err as { error?: { code?: string; param?: string } }).error;
    return detail?.code === "unsupported_value" && detail?.param === "reasoning_effort";
  }

  /** OpenAI's 400 message for an unknown reasoning_effort spells out the
   *  accepted values: `Supported values are: 'none', 'low', ..., and 'high'.`
   *  We pull those out so we can pick the lowest-effort one that works. */
  private parseSupportedReasoningEfforts(err: unknown): string[] {
    const message = String(
      (err as { error?: { message?: string }; message?: string })?.error?.message ??
        (err as { message?: string })?.message ??
        "",
    );
    const after = message.split(/Supported values are:/i)[1];
    if (!after) return [];
    const matches = after.match(/'([^']+)'/g) ?? [];
    return matches.map((m) => m.slice(1, -1));
  }

  private pickLowestReasoningEffort(supported: string[]): string | null {
    const set = new Set(supported);
    for (const value of OpenAIProvider.REASONING_EFFORT_PREFERENCE) {
      if (set.has(value)) return value;
    }
    return null;
  }

  /** Wraps a chat completion so the first request that gets rejected for
   *  an unsupported `reasoning_effort` is retried with a value the model
   *  actually accepts (and the choice is cached for subsequent calls). */
  private async createWithReasoningRetry(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(params);
    } catch (err) {
      if (!this.isUnsupportedReasoningEffortError(err)) throw err;
      const supported = this.parseSupportedReasoningEfforts(err);
      const replacement = this.pickLowestReasoningEffort(supported);
      this.learnedReasoningEffort = replacement;
      const retryParams = { ...(params as unknown as Record<string, unknown>) };
      if (replacement === null) {
        delete retryParams.reasoning_effort;
      } else {
        retryParams.reasoning_effort = replacement;
      }
      logger.warn(
        {
          provider: "openai",
          model: this.model,
          rejected: (params as unknown as Record<string, unknown>).reasoning_effort,
          supported,
          using: replacement,
        },
        "OpenAI rejected reasoning_effort; retrying with the lowest supported value",
      );
      return await this.client.chat.completions.create(
        retryParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      );
    }
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

    const response = await this.createWithReasoningRetry({
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
    this.track(response.usage, "review");

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending walkthrough request to OpenAI");

    const response = await this.createWithReasoningRetry({
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
    this.track(response.usage, "walkthrough");

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
    this.track(response.usage, "chat");

    return text;
  }

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const extras = opts?.json ? this.structuredOutputExtras() : {};
    const response = await this.createWithReasoningRetry({
      model: this.model,
      [this.tokenParam]: opts?.maxTokens ?? this.tokenBudgetFor("complete"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts?.json ? { response_format: { type: "json_object" as const } } : {}),
      ...extras,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
    this.track(response.usage, "complete");
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
    this.track(response.usage, "issue_chat");

    return text;
  }
}
