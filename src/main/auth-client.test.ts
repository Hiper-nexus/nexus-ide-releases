import { describe, expect, it, vi } from 'vitest';
import { exchangeAuthCode } from './auth-client';

describe('exchangeAuthCode', () => {
  it('troca o code, guarda session/refresh e aplica a licença', async () => {
    const store: Record<string, string> = {};
    const applied: string[] = [];
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await exchangeAuthCode('code123', {
      backendUrl: 'https://api.test',
      fetchFn: fetchFn as unknown as typeof fetch,
      setSecret: (k, v) => {
        store[k] = v;
        return { ok: true };
      },
      applyLicense: (jwt) => {
        applied.push(jwt);
        return { ok: true };
      },
    });
    expect(res.ok).toBe(true);
    expect(store['auth:session']).toBe('s');
    expect(store['auth:refresh']).toBe('r');
    expect(applied).toEqual(['jwt']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test/v1/auth/exchange',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('erro do backend não guarda nada', async () => {
    const store: Record<string, string> = {};
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    const res = await exchangeAuthCode('x', {
      backendUrl: 'https://api.test',
      fetchFn: fetchFn as unknown as typeof fetch,
      setSecret: (k, v) => {
        store[k] = v;
        return { ok: true };
      },
      applyLicense: () => ({ ok: true }),
    });
    expect(res.ok).toBe(false);
    expect(Object.keys(store)).toHaveLength(0);
  });
});
