import { describe, expect, it } from 'vitest';
import { classifyRateLimitText } from './classify';

describe('provider response classification', () => {
  it('does not classify a task mentioning an internal-error code or a status-table label', () => {
    expect(classifyRateLimitText('Investigue internal_error no app iOS.')).toBeNull();
    expect(classifyRateLimitText('Failure|rate-limit')).toBeNull();
  });
  it('classifies actual responses without returning arbitrary JSON fields as the reason', () => {
    expect(classifyRateLimitText('API Error: {"request_id":"opaque","error":{"type":"internal_error"}}'))
      .toEqual({ reason: 'SERVER_ERROR', matched: 'internal_error' });
    expect(classifyRateLimitText('Failure: rate-limit exceeded')?.reason).toBe('RATE_LIMIT_EXCEEDED');
  });
});
