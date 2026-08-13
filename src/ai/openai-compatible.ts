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
//   - `reasoning_effort` is opt-IN (see `reasoningEffort` below), because a
//     local runtime that has never heard of the field would reject the request.
export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private jsonMode: boolean;
  private providerLabel: string;
  private timeoutMs: number;

  /** Configured `reasoning_effort`, or undefined to send no such field.
   *  Hosted reasoning models reachable over this adapter (grok-4.5 defaults to
   *  "high", DeepSeek-R1, Qwen-thinking, …) otherwise spend an unbounded slice
   *  of the budget on hidden chain-of-thought. Measured on grok-4.5 over three
   *  real PRs: "high" took 34-136s per review against a 35s primary deadline,
   *  so most reviews blew the deadline and were served by the backup instead.
   *  At the extreme this is also how `OpenAIProvider` ended up with empty
   *  `message.content` for gpt-5+ (bf76968), which is why setting this also
   *  switches the provider to the roomier reasoning token budgets. */
  private reasoningEffort: string | undefined;

  /** Set once a backend has rejected `reasoning_effort`, so we stop sending it
   *  for the rest of the process rather than eating a retry on every call. */
  private reasoningEffortRejected = false;

  constructor(opts: {
    baseURL: string;
    model: string;
    apiKey?: string;
    jsonMode?: boolean;
    reasoningEffort?: string;
    providerLabel?: string;
    timeoutMs?: number;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : "not-needed",
      baseURL: opts.baseURL,
    });
    this.model = opts.model;
    this.jsonMode = opts.jsonMode !== false;
    this.reasoningEffort = opts.reasoningEffort && opts.reasoningEffort.length > 0 ? opts.reasoningEffort : undefined;
    this.providerLabel = opts.providerLabel || "openai-compatible";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AI_REQUEST_TIMEOUT_MS;
  }

  /** The `reasoning_effort` field to merge into a request, if any.
   *
   *  Applied to EVERY request shape — review, walkthrough, chat, issue chat and
   *  complete. `OpenAIProvider` scopes its equivalent to JSON surfaces because
   *  it *infers* the effort from the model family and only wants that guess
   *  where hidden reasoning is known to be wasted. Here the operator has
   *  declared an effort for this specific endpoint, so honouring it everywhere
   *  is what they asked for. Applying it selectively would also be incoherent
   *  with `tokenBudgetFor`, which widens the budget for every one of those
   *  shapes. */
  private reasoningExtras(): Record<string, unknown> {
    if (!this.reasoningActive) return {};
    return { reasoning_effort: this.reasoningEffort };
  }

  /** Whether reasoning is actually in play: configured AND not rejected by this
   *  endpoint. Everything that widens a budget keys off THIS rather than off
   *  `reasoningEffort` alone — once a backend has refused the field there is no
   *  hidden chain-of-thought to leave room for, and holding the wider ceiling
   *  would hand a small-context local runtime a max_tokens it cannot serve. */
  private get reasoningActive(): boolean {
    return !!this.reasoningEffort && !this.reasoningEffortRejected;
  }

  /** Reasoning models split the token budget between hidden CoT and visible
   *  output, so a flat 4096 risks spending the cap before any review is
   *  emitted. Mirrors the ceilings in `OpenAIProvider.tokenBudgetFor`, which
   *  hit exactly that on gpt-5+. Backends without a declared reasoning effort
   *  keep the original budgets exactly. */
  private tokenBudgetFor(task: "review" | "walkthrough" | "chat"): number {
    if (!this.reasoningActive) return task === "chat" ? 2048 : 4096;
    return task === "chat" ? 8192 : 16384;
  }

  /** True for the 400 an endpoint returns when it doesn't know the field at
   *  all (local runtimes) or doesn't accept our value (hosted models with a
   *  different effort alphabet). Either way the fix is the same: drop it. */
  private isReasoningEffortRejection(err: unknown): boolean {
    if (!(err instanceof OpenAI.APIError)) return false;
    if (err.status !== 400) return false;
    const detail = (err as { error?: { param?: string; message?: string } }).error;
    if (detail?.param === "reasoning_effort") return true;
    return /reasoning_effort/i.test(String(detail?.message ?? (err as { message?: string }).message ?? ""));
  }

  /** One bounded chat completion. On timeout this rejects with AiTimeoutError
   *  *before* the caller's `track()` runs, so no cost is recorded for the call.
   *
   *  A request rejected purely for `reasoning_effort` is retried once without
   *  the field (and it is not sent again). Both attempts share one deadline, so
   *  the retry can never extend past the caller's budget. */
  private create(
    operation: string,
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return withAiTimeout(
      { provider: this.providerLabel, operation, timeoutMs: this.timeoutMs },
      async (signal) => {
        try {
          return await this.client.chat.completions.create(params, { signal });
        } catch (err) {
          const sent = (params as unknown as Record<string, unknown>).reasoning_effort;
          if (sent === undefined || !this.isReasoningEffortRejection(err)) throw err;
          this.reasoningEffortRejected = true;
          const retryParams = { ...(params as unknown as Record<string, unknown>) };
          delete retryParams.reasoning_effort;
          logger.warn(
            { provider: this.providerLabel, model: this.model, rejected: sent },
            "Endpoint rejected reasoning_effort; retrying without it and omitting it from later calls",
          );
          return await this.client.chat.completions.create(
            retryParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            { signal },
          );
        }
      },
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
      ...this.reasoningExtras(),
    });
  }

  async review(context: PRContext, repoConfig?: RepoConfig, learnings?: Learning[]): Promise<ReviewResult> {
    const { system, user } = buildReviewPrompt(context, repoConfig, learnings);
    const log = logger.child({ provider: this.providerLabel, model: this.model });

    log.info("Sending review request to OpenAI-compatible endpoint");

    const response = await this.jsonCall("review", system, user, this.tokenBudgetFor("review"));

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

    const response = await this.jsonCall("walkthrough", system, user, this.tokenBudgetFor("walkthrough"));

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
      max_tokens: this.tokenBudgetFor("chat"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...this.reasoningExtras(),
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

  /** `opts.maxTokens` is sized by callers for VISIBLE output only (verify.ts
   *  asks for 1024, learnings.ts for 400). On a reasoning model that same
   *  number is the combined CoT+output budget, so the hidden reasoning eats it
   *  whole and the caller parses an empty string — for verify.ts that silently
   *  fails open and keeps every finding. Give reasoning its own headroom while
   *  still honouring the caller's figure as a floor.
   *
   *  The effort goes on EVERY complete() call, not just the JSON ones — see
   *  `reasoningExtras` for why it is endpoint-wide here. The non-JSON caller is
   *  reviewer.ts's connectivity probe ("reply with the single word: pong",
   *  maxTokens 16): exactly the request that should not sit through a full
   *  chain-of-thought, and one whose measured latency is a health signal. */
  async complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string> {
    const requested = opts?.maxTokens ?? 512;
    const response = await this.create("complete", {
      model: this.model,
      max_tokens: this.reasoningActive ? Math.max(requested, 4096) : requested,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(opts?.json ? { response_format: { type: "json_object" as const } } : {}),
      ...this.reasoningExtras(),
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
      max_tokens: this.tokenBudgetFor("chat"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...this.reasoningExtras(),
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
