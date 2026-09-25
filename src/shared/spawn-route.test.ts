import { describe, expect, it } from 'vitest';
import { JEV_UNAVAILABLE_LABEL, isJevUnavailableReason } from './spawn-route';

describe('spawn-route', () => {
  it('reconhece só motivos conhecidos', () => {
    expect(isJevUnavailableReason('no-key')).toBe(true);
    expect(isJevUnavailableReason('timeout')).toBe(true);
    expect(isJevUnavailableReason('whatever')).toBe(false);
    expect(isJevUnavailableReason(undefined)).toBe(false);
  });

  it('tem rótulo pt-BR para todo motivo', () => {
    expect(JEV_UNAVAILABLE_LABEL['no-key']).toBe('sem chave');
    for (const label of Object.values(JEV_UNAVAILABLE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
