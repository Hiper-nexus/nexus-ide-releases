import { afterEach, describe, expect, it } from 'vitest';
import { peekKimiSeatReadiness, rememberKimiSeatReadiness } from './seat-auth-readiness';
import { refreshKimiSeatReadiness } from './kimi-seat-probe';

afterEach(() => {
  rememberKimiSeatReadiness(undefined);
});

describe('refreshKimiSeatReadiness', () => {
  it('source=oauth é present e vence stale missing', async () => {
    rememberKimiSeatReadiness('missing');
    const readiness = await refreshKimiSeatReadiness({
      execProviderList: async () => ({
        stdout: JSON.stringify({ providers: [{ source: 'oauth' }] }),
        stderr: 'No providers configured',
      }),
    });
    expect(readiness).toBe('present');
    expect(peekKimiSeatReadiness()).toBe('present');
  });

  it('list fresco "No providers configured" atualiza o cache', async () => {
    rememberKimiSeatReadiness('present');
    const readiness = await refreshKimiSeatReadiness({
      execProviderList: async () => ({
        stdout: 'No providers configured',
        stderr: '',
      }),
    });
    expect(readiness).toBe('missing');
  });

  it('ENOENT é missing; outro erro é unreadable', async () => {
    const missing = await refreshKimiSeatReadiness({
      execProviderList: async () => {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      },
    });
    expect(missing).toBe('missing');

    rememberKimiSeatReadiness(undefined);
    const unreadable = await refreshKimiSeatReadiness({
      execProviderList: async () => {
        throw new Error('timeout');
      },
    });
    expect(unreadable).toBe('unreadable');
  });
});
