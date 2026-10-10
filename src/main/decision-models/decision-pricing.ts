import type { JevResult } from '../jev/jev-client';

const MILLION_TOKENS = 1_000_000;
/** Tarifas públicas por milhão de tokens de entrada (Cloudflare, 09/10/2026: Flash caiu de 0,09 para 0,038). */
const INPUT_USD_PER_MILLION = { jev: 0.042, clef: 0.24, 'clef-flash': 0.038, 'clef-omni': 0.15, 'gpt-6-luna': 0.10 } as const;

function isClefModel(model: string): model is 'clef' | 'clef-flash' | 'clef-omni' {
  return model === 'clef' || model === 'clef-flash' || model === 'clef-omni';
}

export function decisionResultCostUsd(result: JevResult): number {
  const model = result.model.replace('@cf/cloudflare/', '');
  const luna = result.route?.provider === 'luna' || model === 'gpt-6-luna';
  const price = luna ? INPUT_USD_PER_MILLION['gpt-6-luna']
    : result.route?.provider !== 'jev' && isClefModel(model)
      ? INPUT_USD_PER_MILLION[model] : INPUT_USD_PER_MILLION.jev;
  return result.usage.input_tokens * price / MILLION_TOKENS;
}
