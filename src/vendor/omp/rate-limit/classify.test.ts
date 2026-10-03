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

describe('F-764: prefixo de linha sem backtracking quadrático', () => {
  it('reconhece o erro atrás de moldura, marcador e espaços', () => {
    expect(classifyRateLimitText('  │  internal_error')?.reason).toBe('SERVER_ERROR');
    expect(classifyRateLimitText('⎿   API error: internal_error')?.reason).toBe('SERVER_ERROR');
    expect(classifyRateLimitText('•\tprovider error: internal-server-error:')?.reason).toBe('SERVER_ERROR');
    expect(classifyRateLimitText('status code:   503')?.reason).toBe('MODEL_CAPACITY_EXHAUSTED');
    expect(classifyRateLimitText('error =500')?.reason).toBe('SERVER_ERROR');
  });

  it.each([
    ['espaço sem quebra', ' '.repeat(16_384)],
    ['linhas em branco', `${' '.repeat(131)}\n`.repeat(125)],
    ['"status" seguido de espaço', `status${' '.repeat(16_378)}`],
  ])('%s: tempo linear', (_label, text) => {
    classifyRateLimitText(text);
    const startedAt = performance.now();
    expect(classifyRateLimitText(text)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
