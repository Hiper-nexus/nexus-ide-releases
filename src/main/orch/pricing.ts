/**
 * Model pricing table + pure cost/token estimation helpers.
 *
 * Prices are USD per MILLION tokens (input/output), matched by model-id
 * prefix after stripping any provider namespace ("moonshot/kimi-k2" → matches
 * "kimi"). The longest matching prefix wins, so "gemini-flash" beats "gemini".
 * Values are ballpark public list prices — the tracker is an estimator, not a
 * billing system.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

/** Fallback when no prefix matches (mid-tier assistant pricing). */
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 3, outputPerM: 15 };

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus': { inputPerM: 15, outputPerM: 75 },
  'claude-sonnet': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku': { inputPerM: 1, outputPerM: 5 },
  claude: { inputPerM: 3, outputPerM: 15 },
  'gpt-5-mini': { inputPerM: 0.25, outputPerM: 2 },
  'gpt-5': { inputPerM: 1.25, outputPerM: 10 },
  'gemini-3.6-flash': { inputPerM: 1.5, outputPerM: 7.5 },
  'gemini-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  gemini: { inputPerM: 1.25, outputPerM: 10 },
  mimo: { inputPerM: 0.2, outputPerM: 0.6 },
  kimi: { inputPerM: 0.6, outputPerM: 2.5 },
  moonshot: { inputPerM: 0.6, outputPerM: 2.5 },
  deepseek: { inputPerM: 0.27, outputPerM: 1.1 },
  glm: { inputPerM: 0.6, outputPerM: 2.2 },
  grok: { inputPerM: 3, outputPerM: 15 },
  qwen: { inputPerM: 0.4, outputPerM: 1.2 },
  // longcat.chat/platform list price (promo atual: 0.30 in / 1.20 out).
  longcat: { inputPerM: 0.75, outputPerM: 2.95 },
};

/** Heuristic: ~4 chars per token (used when no real usage counts exist). */
const CHARS_PER_TOKEN = 4;

/** Strip provider namespaces ("moonshot/kimi-k2" → "kimi-k2") and normalize. */
function normalizeModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  return lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
}

/** Resolve the price entry for a model id (longest prefix wins). */
export function priceForModel(model: string | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  const id = normalizeModelId(model);
  let best: { prefix: string; price: ModelPrice } | null = null;
  for (const [prefix, price] of Object.entries(MODEL_PRICES)) {
    if (!id.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, price };
  }
  return best?.price ?? DEFAULT_PRICE;
}

/** Estimated USD cost of a token pair for a model. Pure. */
export function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceForModel(model);
  return (
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM
  );
}

/** Rough token count for a text chunk (~4 chars/token heuristic). Pure. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
