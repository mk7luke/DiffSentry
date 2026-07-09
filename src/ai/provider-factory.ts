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
  /** Overrides the openai-compatible provider label (for cost/log attribution
   *  when a same-type backup would otherwise collide with the primary). */
  label?: string;
}

export function buildProvider(spec: ProviderSpec): AIProvider {
  if (spec.provider === "anthropic") {
    return new AnthropicProvider(spec.anthropicApiKey!, spec.anthropicModel, spec.anthropicBaseUrl, spec.timeoutMs);
  }
  if (spec.provider === "openai-compatible") {
    return new OpenAICompatibleProvider({
      baseURL: spec.localAiBaseUrl!,
      model: spec.localAiModel,
      apiKey: spec.localAiApiKey,
      jsonMode: spec.localAiJsonMode,
      timeoutMs: spec.timeoutMs,
      providerLabel: spec.label,
    });
  }
  return new OpenAIProvider(spec.openaiApiKey!, spec.openaiModel, spec.openaiBaseUrl, spec.timeoutMs);
}
