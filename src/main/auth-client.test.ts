import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLogin, exchangeAuthCode, resetPendingLogin, getAuthenticatedAccountId, bindAuthenticatedAccount, restoreAuthenticatedAccount } from './auth-client';

function okFetch() {
  return vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } }),
      { headers: { 'content-type': 'application/json' } },
    ),
  ).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'account-a' } })));
}

function deps(over: Record<string, unknown> = {}) {
  return {
    backendUrl: 'https://api.test',
    fetchFn: okFetch() as unknown as typeof fetch,
    setSecret: vi.fn().mockReturnValue({ ok: true }),
    validateLicense: vi.fn().mockReturnValue({ ok: true }),
    bindAccount: vi.fn().mockReturnValue({ ok: true }),
    clearAccess: vi.fn(),
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
    expect(r.error).toBe('exchange-storage');
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


describe('session identity binding', () => {
  beforeEach(() => resetPendingLogin());
  it('binds the license to the independently authenticated /me subject', async () => {
    const d = deps();
    beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    expect((await exchangeAuthCode('c', state, d)).ok).toBe(true);
    expect(d.bindAccount).toHaveBeenCalledWith('account-a', 's');
    expect(d.fetchFn).toHaveBeenLastCalledWith('https://api.test/v1/me', expect.objectContaining({ headers: { authorization: 'Bearer s' } }));
  });
  it('refuses an exchange completed after logout or a replacement login', async () => {
    let done!: (r: Response) => void;
    const d = deps({ fetchFn: vi.fn(() => new Promise<Response>(resolve => { done = resolve; })) });
    beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    const flight = exchangeAuthCode('c', state, d);
    resetPendingLogin();
    done(new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } })));
    expect((await flight).ok).toBe(false);
    expect(d.setSecret).not.toHaveBeenCalled();
    expect(d.applyLicense).not.toHaveBeenCalled();
  });
});


function identityStore() {
  const values = new Map<string, string>();
  return { values, getSecret: (key: string) => values.get(key) ?? null,
    hasCachedSecret: (key: string) => values.has(key),
    setSecret: (key: string, value: string) => { values.set(key, value); return { ok: true }; } };
}
it('cached identity belongs to exactly one opaque session and never unlocks the vault in a query', () => {
  const store = identityStore();
  const read = vi.spyOn(store, 'getSecret');
  expect(getAuthenticatedAccountId(store)).toBeNull();
  expect(read).not.toHaveBeenCalled();
  store.setSecret('auth:session', 'session-a');
  bindAuthenticatedAccount('account-a', 'session-a', store);
  expect(getAuthenticatedAccountId(store)).toBe('account-a');
  store.setSecret('auth:session', 'session-b');
  expect(getAuthenticatedAccountId(store)).toBeNull();
});
it('restores an old session identity after network recovery, but never after logout', async () => {
  const store = identityStore();
  store.setSecret('auth:session', 'session-a');
  const api = vi.fn().mockResolvedValueOnce({ status: 0, json: null })
    .mockResolvedValueOnce({ status: 200, json: { ok: true, data: { id: 'account-a' } } });
  await restoreAuthenticatedAccount({ store, api });
  expect(getAuthenticatedAccountId(store)).toBeNull();
  await restoreAuthenticatedAccount({ store, api });
  expect(getAuthenticatedAccountId(store)).toBe('account-a');
  store.values.delete('auth:account');
  let finish!: (value: unknown) => void;
  const lateApi = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const flight = restoreAuthenticatedAccount({ store, api: lateApi as never });
  resetPendingLogin();
  store.values.delete('auth:session');
  finish({ status: 200, json: { ok: true, data: { id: 'account-a' } } });
  await flight;
  expect(getAuthenticatedAccountId(store)).toBeNull();
});


it('rejects an invalid exchange license before replacing the previous session', async () => {
  resetPendingLogin();
  const d = deps({ validateLicense: vi.fn().mockReturnValue({ ok: false, error: 'account-mismatch' }) });
  beginLogin('github', d);
  const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
  expect((await exchangeAuthCode('c', state, d)).ok).toBe(false);
  expect(d.clearAccess).not.toHaveBeenCalled();
  expect(d.setSecret).not.toHaveBeenCalled();
});



it.each(['parse', 'network', 'storage'])('M3: %s auth failure never returns or logs response/exception secrets', async kind => {
  resetPendingLogin();
  const marker = 'secretXYZ';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = deps(kind === 'parse' ? { fetchFn: vi.fn().mockResolvedValue(new Response(marker + '{')) }
    : kind === 'network' ? { fetchFn: vi.fn().mockRejectedValue(new Error(marker)) }
    : { setSecret: vi.fn().mockReturnValue({ ok: false, error: marker }) });
  beginLogin('github', d);
  const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
  const result = await exchangeAuthCode('code', state, d);
  expect(result.ok).toBe(false);
  expect(JSON.stringify([result, warn.mock.calls, error.mock.calls])).not.toContain(marker);
  warn.mockRestore(); error.mockRestore();
});
