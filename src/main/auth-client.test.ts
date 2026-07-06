import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLogin, exchangeAuthCode, resetPendingLogin } from './auth-client';

function okFetch() {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
}

function deps(over: Record<string, unknown> = {}) {
  return {
    backendUrl: 'https://api.test',
    fetchFn: okFetch() as unknown as typeof fetch,
    setSecret: vi.fn().mockReturnValue({ ok: true }),
    applyLicense: vi.fn().mockReturnValue({ ok: true }),
    openExternal: vi.fn(),
    ...over,
  };
}

describe('beginLogin', () => {
  beforeEach(() => resetPendingLogin());

  it('gera nonce, abre o browser com app_state e deixa login pendente', () => {
    const d = deps();
    const r = beginLogin('github', d);
    expect(r.ok).toBe(true);
    expect(d.openExternal).toHaveBeenCalledTimes(1);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v1/auth/github');
    const nonce = url.searchParams.get('app_state')!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });
});

describe('exchangeAuthCode (binding local)', () => {
  beforeEach(() => resetPendingLogin());

  it('sem login pendente → rejeita (anti login-CSRF)', async () => {
    const d = deps();
    const r = await exchangeAuthCode('code123', 'qualquer', d);
    expect(r.ok).toBe(false);
    expect(d.setSecret).not.toHaveBeenCalled();
  });

  it('state que não casa com o pendente → rejeita e NÃO consome o code', async () => {
    const d = deps();
    beginLogin('github', d);
    const r = await exchangeAuthCode('code123', 'nonce-de-atacante', d);
    expect(r.ok).toBe(false);
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(d.setSecret).not.toHaveBeenCalled();
  });

  it('state correto: troca o code, guarda tokens e aplica licença', async () => {
    const d = deps();
    beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const nonce = url.searchParams.get('app_state')!;
    const r = await exchangeAuthCode('code123', nonce, d);
    expect(r).toEqual({ ok: true });
    expect(d.setSecret).toHaveBeenCalledWith('auth:session', 's');
    expect(d.setSecret).toHaveBeenCalledWith('auth:refresh', 'r');
    expect(d.applyLicense).toHaveBeenCalledWith('jwt');
  });

  it('nonce é single-use: segundo deep link com o mesmo state → rejeita', async () => {
    const d = deps();
    beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const nonce = url.searchParams.get('app_state')!;
    expect((await exchangeAuthCode('c1', nonce, d)).ok).toBe(true);
    expect((await exchangeAuthCode('c2', nonce, d)).ok).toBe(false);
  });

  it('falha ao persistir secret ou licença → falha FECHADO', async () => {
    const d = deps({ setSecret: vi.fn().mockReturnValue({ ok: false, error: 'keychain' }) });
    beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const r = await exchangeAuthCode('code123', url.searchParams.get('app_state')!, d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/keychain/);
  });

  it('erro do backend não guarda nada', async () => {
    const d = deps({ fetchFn: vi.fn().mockResolvedValue(new Response('nope', { status: 400 })) });
    beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const r = await exchangeAuthCode('x', url.searchParams.get('app_state')!, d);
    expect(r.ok).toBe(false);
    expect(d.setSecret).not.toHaveBeenCalled();
  });
});
