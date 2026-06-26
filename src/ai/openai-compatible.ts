import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning, IssueContext } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt, buildIssueChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
import { recordAiUsage } from "./cost.js";
import { withAiTimeout, DEFAULT_AI_REQUEST_TIMEOUT_MS } from "./timeout.js";
import { logger } from "../logger.js";

// Adapter for any OpenAI-compatible `/v1/chat/completions` endpoint:
// Ollama (`http://host:11434/v1`), LM Studio (`http://host:1234/v1`),
// vLLM, llama.cpp server (`llama-server`), LocalAI, Groq, Together, etc.
//
// Differences from `OpenAIProvider`:
//   - API key is optional (most local servers ignore it; OpenAI SDK requires a
//     non-empty string, so we default to "not-needed").
//   - `response_format: json_object` is opt-out, because some backends reject
//     the field outright. When disabled, we rely on `parseReviewResponse`'s
//     tolerant JSON extraction (it already strips ``` fences).
//   - No `max_completion_tokens` branch — local runtimes use `max_tokens`.
export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private jsonMode: boolean;
  private providerLabel: string;
  private timeoutMs: number;

  constructor(opts: {
    baseURL: string;
    model: string;
    apiKey?: string;
    jsonMode?: boolean;
    providerLabel?: string;
    timeoutMs?: number;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : "not-needed",
      baseURL: opts.baseURL,
    });
    this.model = opts.model;
    this.jsonMode = opts.jsonMode !== false;
    this.providerLabel = opts.providerLabel || "openai-compatible";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AI_REQUEST_TIMEOUT_MS;
  }

  /** One bounded chat completion. On timeout this rejects with AiTimeoutError
   *  *before* the caller's `track()` runs, so no cost is recorded for the call. */
  private create(
    operation: string,
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return withAiTimeout(
      { provider: this.providerLabel, operation, timeoutMs: this.timeoutMs },
      (signal) => this.client.chat.completions.create(params, { signal }),
    );
  }

  /** Record token usage + cost for one call (best-effort, never throws). */
  private track(
    usage: { prompt_tokens?: number; completion_tokens?: number } | undefined | null,
    kind: string,
  ): void {
    recordAiUsage({
      provider: this.providerLabel,
      model: this.model,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      fallbackKind: kind,
    });
  }

  private async jsonCall(operation: string, system: string, user: string, maxTokens: number) {
    return this.create(operation, {
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(this.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    });
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending review request to OpenAI-compatible endpoint");

    const response = await this.jsonCall("review", system, user, 4096);

    const text = response.choices[0]?.message?.content || "";
    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI-compatible review response received"
    );
    this.track(response.usage, "review");

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending walkthrough request to OpenAI-compatible endpoint");

    const response = await this.jsonCall("walkthrough", system, user, 4096);

    const text = response.choices[0]?.message?.content || "";
    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI-compatible walkthrough response received"
    );
    this.track(response.usage, "walkthrough");

    return parseWalkthroughResponse(text);
  }

  async chat(context: PRContext, userMessage: string, _repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildChatPrompt(context, userMessage);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending chat request to OpenAI-compatible endpoint");

    const response = await this.create("chat", {
      model: this.model,
      max_tokens: 2048,
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
      "OpenAI-compatible chat response received"
    );
    this.track(response.usage, "chat");

    return text;
  }

  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const response = await this.create("complete", {
      model: this.model,
      max_tokens: opts?.maxTokens ?? 512,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts?.json ? { response_format: { type: "json_object" as const } } : {}),
    });
    this.track(response.usage, "complete");
    return response.choices[0]?.message?.content || "";
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildIssueChatPrompt(context, userMessage, repoConfig);
    const log = logger.child({ provider: this.providerLabel, model: this.model, surface: "issue" });

    log.info("Sending issue chat request to OpenAI-compatible endpoint");

    const response = await this.create("issue_chat", {
      model: this.model,
      max_tokens: 2048,
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
      "OpenAI-compatible issue chat response received"
    );
    this.track(response.usage, "issue_chat");

    return text;
  }
}
