import { describe, expect, it } from 'vitest';
import { assessCliUpdate } from './cli-update-observation';

describe('CLI update observation', () => {
  it('never attributes a PATH switch to the selected installer', () => {
    expect(assessCliUpdate({
      beforeBin: '/Users/operator/.local/bin/claude',
      beforeVersion: '2.1.278',
      afterBin: '/Users/operator/.npm-global/bin/claude',
      afterVersion: '2.1.280',
      platform: 'darwin',
    })).toBe('different-launcher');
  });

  it('distinguishes an updated launcher from an unchanged or unreadable baseline', () => {
    const base = {
      beforeBin: '/Users/operator/.local/bin/claude',
      afterBin: '/Users/operator/.local/bin/claude',
      afterVersion: '2.1.280',
      platform: 'darwin' as const,
    };
    expect(assessCliUpdate({ ...base, beforeVersion: '2.1.278' })).toBe('updated');
    expect(assessCliUpdate({ ...base, beforeVersion: '2.1.280' })).toBe('unchanged');
    expect(assessCliUpdate({ ...base, beforeVersion: null })).toBe('verified');
  });
});
