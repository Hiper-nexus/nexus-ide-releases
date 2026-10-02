import type { JevResult } from '../jev/jev-client';
import type { JevDecisionInput } from '../jev/jev-decision-log';
import { decisionResultCostUsd } from './decision-pricing';

export function decisionResultUsage(result: JevResult): Pick<JevDecisionInput,
  'provider' | 'route' | 'durationMs' | 'requestCount' | 'inputTokens' | 'usd' | 'usageIncomplete'> {
  const tokens = result.usage?.input_tokens;
  const measured = !result.usageMissing && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
  return {
    ...(measured ? {} : { usageIncomplete: true }),
    provider: result.route?.provider ?? (result.model.replace('@cf/cloudflare/', '').startsWith('clef') ? 'clef' : 'jev'),
    route: result.route, durationMs: result.durationMs, requestCount: result.requestCount,
    inputTokens: measured ? tokens : null, usd: measured ? decisionResultCostUsd(result) : null,
  };
}
