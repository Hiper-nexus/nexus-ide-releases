import type { DecisionProvider } from '../../shared/decision-models';
import type { JevResult } from '../jev/jev-client';

const MILLION_TOKENS = 1_000_000;
/** Tarifas públicas por milhão de tokens de entrada (Cloudflare, 09/10/2026: Flash caiu de 0,09 para 0,038). */
const INPUT_USD_PER_MILLION = { jev: 0.042, clef: 0.24, 'clef-flash': 0.038, 'clef-omni': 0.15, 'gpt-6-luna': 0.10 } as const;

function isClefModel(model: string): model is 'clef' | 'clef-flash' | 'clef-omni' {
  return model === 'clef' || model === 'clef-flash' || model === 'clef-omni';
}

/** Tarifa de entrada por milhão de tokens do par provedor/modelo (a mesma que mede o recibo). */
export function decisionInputUsdPerMillion(provider: DecisionProvider | undefined, model: string): number {
  const selector = model.replace('@cf/cloudflare/', '');
  if (provider === 'luna' || selector === 'gpt-6-luna') return INPUT_USD_PER_MILLION['gpt-6-luna'];
  return provider !== 'jev' && isClefModel(selector) ? INPUT_USD_PER_MILLION[selector] : INPUT_USD_PER_MILLION.jev;
}

export function decisionResultCostUsd(result: JevResult): number {
  return result.usage.input_tokens * decisionInputUsdPerMillion(result.route?.provider, result.model) / MILLION_TOKENS;
}

/** Tokens por imagem/clipe na estimativa prévia: teto conservador, nunca medido. */
const ESTIMATED_TOKENS_PER_IMAGE = 1_600;
const ESTIMATED_TOKENS_PER_AUDIO = 1_200;
const MIN_ESTIMATED_TOKENS = 200;

/**
 * Estimativa ANTES da chamada (reserva de orçamento). ~3 caracteres por token
 * superestima de propósito: o acerto pelo recibo real devolve a diferença.
 */
export function estimateDecisionInputTokens(input: {
  state: unknown; questions: unknown; images?: readonly unknown[]; audio?: readonly unknown[];
}): number {
  let chars = 0;
  try { chars = JSON.stringify({ state: input.state, questions: input.questions })?.length ?? 0; }
  catch { chars = 0; }
  return Math.max(MIN_ESTIMATED_TOKENS, Math.ceil(chars / 3))
    + (input.images?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE
    + (input.audio?.length ?? 0) * ESTIMATED_TOKENS_PER_AUDIO;
}

export function estimateDecisionCostUsd(tokens: number, provider: DecisionProvider, model: string): number {
  return tokens * decisionInputUsdPerMillion(provider, model) / MILLION_TOKENS;
}
