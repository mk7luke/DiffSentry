import OpenAI from "openai";
import { AIProvider, PRContext, ReviewResult } from "../types.js";
import { buildPrompt } from "./prompt.js";
import { parseReviewResponse } from "./parse.js";
import { logger } from "../logger.js";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async review(context: PRContext): Promise<ReviewResult> {
    const { system, user } = buildPrompt(context);
    const log = logger.child({ provider: "openai", model: this.model });

    log.info("Sending review request to OpenAI");

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
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
      "OpenAI response received"
    );

    return parseReviewResponse(text, context);
  }
}
