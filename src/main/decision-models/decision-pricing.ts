import type { JevResult } from '../jev/jev-client';

const MILLION_TOKENS = 1_000_000;
const INPUT_USD_PER_MILLION = { jev: 0.042, clef: 0.24, 'clef-flash': 0.09 } as const;

export function decisionResultCostUsd(result: JevResult): number {
  const model = result.model.replace('@cf/cloudflare/', '');
  const price = result.route?.provider !== 'jev' && (model === 'clef' || model === 'clef-flash')
    ? INPUT_USD_PER_MILLION[model] : INPUT_USD_PER_MILLION.jev;
  return result.usage.input_tokens * price / MILLION_TOKENS;
}
