import Anthropic from "@anthropic-ai/sdk";
import { AIProvider, PRContext, ReviewResult } from "../types.js";
import { buildPrompt } from "./prompt.js";
import { parseReviewResponse } from "./parse.js";
import { logger } from "../logger.js";

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async review(context: PRContext): Promise<ReviewResult> {
    const { system, user } = buildPrompt(context);
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
      "Anthropic response received"
    );

    return parseReviewResponse(text, context);
  }
}
