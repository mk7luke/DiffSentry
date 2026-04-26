import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult, WalkthroughResult, RepoConfig, Learning, IssueContext } from "../types.js";
import { buildReviewPrompt, buildWalkthroughPrompt, buildChatPrompt, buildIssueChatPrompt } from "./prompt.js";
import { parseReviewResponse, parseWalkthroughResponse } from "./parse.js";
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

  constructor(opts: {
    baseURL: string;
    model: string;
    apiKey?: string;
    jsonMode?: boolean;
    providerLabel?: string;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : "not-needed",
      baseURL: opts.baseURL,
    });
    this.model = opts.model;
    this.jsonMode = opts.jsonMode !== false;
    this.providerLabel = opts.providerLabel || "openai-compatible";
  }

  private async jsonCall(system: string, user: string, maxTokens: number) {
    return this.client.chat.completions.create({
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

    const response = await this.jsonCall(system, user, 4096);

    const text = response.choices[0]?.message?.content || "";
    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI-compatible review response received"
    );

    return parseReviewResponse(text, context);
  }

  async generateWalkthrough(context: PRContext, repoConfig?: RepoConfig): Promise<WalkthroughResult> {
    const { system, user } = buildWalkthroughPrompt(context, repoConfig);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending walkthrough request to OpenAI-compatible endpoint");

    const response = await this.jsonCall(system, user, 4096);

    const text = response.choices[0]?.message?.content || "";
    log.info(
      {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      "OpenAI-compatible walkthrough response received"
    );

    return parseWalkthroughResponse(text);
  }

  async chat(context: PRContext, userMessage: string, _repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildChatPrompt(context, userMessage);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending chat request to OpenAI-compatible endpoint");

    const response = await this.client.chat.completions.create({
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

    return text;
  }

  async chatIssue(context: IssueContext, userMessage: string, repoConfig?: RepoConfig): Promise<string> {
    const { system, user } = buildIssueChatPrompt(context, userMessage, repoConfig);
    const log = logger.child({ provider: this.providerLabel, model: this.model, surface: "issue" });

    log.info("Sending issue chat request to OpenAI-compatible endpoint");

    const response = await this.client.chat.completions.create({
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

    return text;
  }
}
