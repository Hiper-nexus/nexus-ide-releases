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

/** Known lower bounds remain measured; omitted measurements never become zero. */
export function aggregateDecisionUsage(results: readonly JevResult[], incomplete = false): ReturnType<typeof decisionResultUsage> {
  const receipts = results.map(decisionResultUsage);
  const sum = (field: 'inputTokens' | 'usd'): number | null => {
    const known = receipts.flatMap(receipt => receipt[field] === null ? [] : [receipt[field]!]);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  return { ...receipts[0], inputTokens: sum('inputTokens'), usd: sum('usd'),
    usageIncomplete: incomplete || !receipts.length || receipts.some(receipt => receipt.usageIncomplete),
    requestCount: receipts.length && receipts.every(receipt => receipt.requestCount !== undefined)
      ? receipts.reduce((total, receipt) => total + receipt.requestCount!, 0) : undefined,
    durationMs: receipts.length && receipts.every(receipt => receipt.durationMs !== undefined)
      ? Math.max(...receipts.map(receipt => receipt.durationMs!)) : undefined,
  };
}
