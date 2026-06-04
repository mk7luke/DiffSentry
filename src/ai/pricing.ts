import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-model price table → cost in USD.
//
// Prices are expressed in USD per 1,000,000 tokens, split into input (prompt)
// and output (completion). The built-in table covers the models DiffSentry
// ships defaults for; everything is overridable at runtime via the
// AI_MODEL_PRICES env var (a JSON object, see parseEnvPrices below) so a self-
// hoster can correct a price or add a model we don't know about without a code
// change.
//
// Model lookup is forgiving: an exact (case-insensitive) match wins, otherwise
// the longest table key that is a prefix of the model id is used. That makes
// dated snapshots like `claude-sonnet-4-20250514` or `gpt-4o-2024-08-06` resolve
// to their family price without an entry per snapshot.
// ─────────────────────────────────────────────────────────────────────────────

/** Price for a model, in USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Built-in defaults (USD per 1M tokens). Keys are lowercase and intentionally
 * coarse (family prefixes) so snapshot suffixes resolve via prefix matching.
 * These are best-effort list prices as of early 2026 — override via env for
 * exact billing.
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Anthropic — Claude
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 0.8, output: 4 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  // OpenAI — GPT / o-series
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
};

/**
 * Parse AI_MODEL_PRICES, a JSON object mapping a model id (or family prefix) to
 * `{ "input": <usd/1M>, "output": <usd/1M> }`. Invalid entries are skipped with
 * a warning rather than failing startup, so one typo can't disable pricing.
 */
function parseEnvPrices(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err }, "AI_MODEL_PRICES is not valid JSON — ignoring overrides");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn("AI_MODEL_PRICES must be a JSON object of { model: { input, output } } — ignoring");
    return {};
  }
  const out: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = value as { input?: unknown; output?: unknown };
    const input = typeof v?.input === "number" ? v.input : Number(v?.input);
    const output = typeof v?.output === "number" ? v.output : Number(v?.output);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      logger.warn({ model }, "AI_MODEL_PRICES entry has non-numeric/negative input or output — skipping");
      continue;
    }
    out[model.trim().toLowerCase()] = { input, output };
  }
  return out;
}

// Merged table is computed once. Env overrides win over (and extend) defaults.
// Re-read lazily so tests/scripts that set the env after import still see it,
// but cache after first build for the hot path.
let _table: Record<string, ModelPrice> | null = null;
let _tableKeysByLen: string[] | null = null;

function table(): Record<string, ModelPrice> {
  if (_table) return _table;
  _table = { ...DEFAULT_PRICES, ...parseEnvPrices(process.env.AI_MODEL_PRICES) };
  // Longest keys first so prefix matching prefers the most specific family
  // (e.g. "gpt-4o-mini" before "gpt-4o", "gpt-5-mini" before "gpt-5").
  _tableKeysByLen = Object.keys(_table).sort((a, b) => b.length - a.length);
  return _table;
}

/** Test/CLI hook: forget the cached table so a later env change is picked up. */
export function resetPriceTableCache(): void {
  _table = null;
  _tableKeysByLen = null;
}

/**
 * Look up the price for a model id. Exact (case-insensitive) match first, then
 * the longest table key that is a prefix of the model id. Returns null when the
 * model is unknown (the caller records tokens with a zero/unknown cost).
 */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const t = table();
  const key = model.trim().toLowerCase();
  if (t[key]) return t[key];
  for (const candidate of _tableKeysByLen ?? []) {
    if (key.startsWith(candidate)) return t[candidate];
  }
  return null;
}

/**
 * Compute the USD cost of a single call. Returns 0 for an unknown model (tokens
 * are still recorded so usage is never lost — only the dollar figure is absent).
 * Rounded to 6 decimal places to keep tiny calls from accumulating float noise.
 */
export function computeCostUsd(
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number {
  const price = priceForModel(model);
  if (!price) return 0;
  const inTok = Number.isFinite(inputTokens as number) ? (inputTokens as number) : 0;
  const outTok = Number.isFinite(outputTokens as number) ? (outputTokens as number) : 0;
  const usd = (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
  return Math.round(usd * 1e6) / 1e6;
}

/** Whether a model has a known price (for diagnostics / UI hints). */
export function hasKnownPrice(model: string | null | undefined): boolean {
  return priceForModel(model) !== null;
}
