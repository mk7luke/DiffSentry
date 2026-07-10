import { AIProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** A fully-resolved recipe for one provider. Both the primary and the backup
 *  are built from one of these, so construction lives in exactly one place. */
export interface ProviderSpec {
  provider: "anthropic" | "openai" | "openai-compatible";
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseUrl?: string;
  localAiBaseUrl?: string;
  localAiApiKey?: string;
  localAiModel: string;
  localAiJsonMode: boolean;
  timeoutMs: number;
  /** Overrides the openai-compatible provider label for cost/log attribution.
   *  Only `OpenAICompatibleProvider` accepts a label, so this disambiguates a
   *  same-type openai-compatible backup from the primary. For anthropic/openai,
   *  attribution relies on provider+model distinctness (`recordAiUsage` keys on
   *  both): a backup with a different model is already distinct; a same-provider
   *  AND same-model backup collapses into the primary in cost/logs (an unusual
   *  config). Extending the anthropic/openai constructors to take a label would
   *  be the follow-up if that pairing ever needs splitting. */
  label?: string;
}

export function buildProvider(spec: ProviderSpec): AIProvider {
  // loadConfig validates the configured provider's credentials at boot, but this
  // factory is a shared construction path for both primary and backup — throw a
  // named error here so a future partial spec fails fast at the factory rather
  // than with an opaque failure deep inside a provider SDK constructor.
  if (spec.provider === "anthropic") {
    if (!spec.anthropicApiKey) {
      throw new Error("buildProvider(anthropic) requires anthropicApiKey");
    }
    return new AnthropicProvider(spec.anthropicApiKey, spec.anthropicModel, spec.anthropicBaseUrl, spec.timeoutMs);
  }
  if (spec.provider === "openai-compatible") {
    if (!spec.localAiBaseUrl || !spec.localAiModel) {
      throw new Error("buildProvider(openai-compatible) requires localAiBaseUrl and localAiModel");
    }
    return new OpenAICompatibleProvider({
      baseURL: spec.localAiBaseUrl,
      model: spec.localAiModel,
      apiKey: spec.localAiApiKey,
      jsonMode: spec.localAiJsonMode,
      timeoutMs: spec.timeoutMs,
      providerLabel: spec.label,
    });
  }
  if (!spec.openaiApiKey) {
    throw new Error("buildProvider(openai) requires openaiApiKey");
  }
  return new OpenAIProvider(spec.openaiApiKey, spec.openaiModel, spec.openaiBaseUrl, spec.timeoutMs);
}
