import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginLogin, probeLoginEndpoint, exchangeAuthCode, resetPendingLogin, getAuthenticatedAccountId, bindAuthenticatedAccount, restoreAuthenticatedAccount, logoutAuthSession, discardRejectedSession } from './auth-client';

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

  it('gera nonce, abre o browser com app_state e deixa login pendente', async () => {
    const d = deps();
    const r = await beginLogin('github', d);
    expect(r.ok).toBe(true);
    expect(d.openExternal).toHaveBeenCalledTimes(1);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v1/auth/github');
    const nonce = url.searchParams.get('app_state')!;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('consulta o servidor com a MESMA url que abriria e só então abre o navegador', async () => {
    const probeLogin = vi.fn().mockResolvedValue(null);
    const d = deps({ probeLogin });
    expect((await beginLogin('google', d)).ok).toBe(true);
    expect(probeLogin).toHaveBeenCalledTimes(1);
    expect(probeLogin.mock.calls[0][0]).toBe(d.openExternal.mock.calls[0][0]);
  });

  it('servidor indisponível: não abre o navegador, não deixa login pendente e diz o motivo', async () => {
    const d = deps({ probeLogin: vi.fn().mockResolvedValue({ status: 503 }) });
    const r = await beginLogin('github', d);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('GitHub') });
    expect(d.openExternal).not.toHaveBeenCalled();
    // Sem login pendente, um deep link forjado depois também não troca nada.
    expect((await exchangeAuthCode('c', 'qualquer-state', d)).error).toBe('nenhum login pendente');
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it('falha de rede na checagem vira mensagem de conexão, sem abrir o navegador', async () => {
    const d = deps({ probeLogin: vi.fn().mockResolvedValue({ network: true }) });
    const r = await beginLogin('google', d);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('conexão');
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it('uma falha não derruba o login pendente de uma tentativa anterior que deu certo', async () => {
    const probeLogin = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 503 });
    const d = deps({ probeLogin });
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    expect((await beginLogin('google', d)).ok).toBe(false);
    expect((await exchangeAuthCode('c', state, d)).ok).toBe(true);
  });
});

describe('beginLogin concorrente (o último clique vence)', () => {
  beforeEach(() => resetPendingLogin());

  it('uma sonda lenta de um clique antigo não sobrescreve o clique mais novo', async () => {
    let releaseOld!: (v: null) => void;
    const probeLogin = vi.fn()
      .mockImplementationOnce(() => new Promise<null>(resolve => { releaseOld = resolve; }))
      .mockResolvedValueOnce(null);
    const d = deps({ probeLogin });
    const older = beginLogin('github', d);
    const newer = await beginLogin('google', d);
    expect(newer.ok).toBe(true);
    releaseOld(null);
    const olderResult = await older;
    expect(olderResult.ok).toBe(false);
    expect(olderResult.ok === false && olderResult.error).toContain('outro login');
    // Só o clique novo abriu o navegador, e o state dele é o que vale.
    expect(d.openExternal).toHaveBeenCalledTimes(1);
    const url = new URL(d.openExternal.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/auth/google');
    expect((await exchangeAuthCode('c', url.searchParams.get('app_state'), d)).ok).toBe(true);
  });

  it('logout durante a sonda cancela o login em voo: nada abre, nada fica pendente', async () => {
    let release!: (v: null) => void;
    const d = deps({ probeLogin: vi.fn(() => new Promise<null>(resolve => { release = resolve; })) });
    const flight = beginLogin('github', d);
    resetPendingLogin();
    release(null);
    const result = await flight;
    expect(result.ok).toBe(false);
    expect(d.openExternal).not.toHaveBeenCalled();
    expect((await exchangeAuthCode('c', 'qualquer', d)).error).toBe('nenhum login pendente');
  });
});

describe('probeLoginEndpoint', () => {
  const probe = (response: Response | Error) => {
    const fetchFn = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
    return { fetchFn, run: () => probeLoginEndpoint('https://api.test/v1/auth/github?app_state=x', fetchFn as unknown as typeof fetch) };
  };

  it('redirecionamento é o caminho feliz e não é seguido', async () => {
    const { fetchFn, run } = probe(new Response(null, { status: 302, headers: { location: 'https://github.com/login/oauth/authorize' } }));
    expect(await run()).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }));
  });

  it.each([503, 502, 429, 400, 404])('status %i é falha definitiva', async status => {
    expect(await probe(new Response('{}', { status })).run()).toEqual({ status });
  });

  it('2xx não bloqueia: o navegador decide (servidor com página intermediária)', async () => {
    expect(await probe(new Response('<html>', { status: 200 })).run()).toBeNull();
  });

  it('descarta o corpo da resposta para liberar o socket', async () => {
    const response = new Response('{"ok":false}', { status: 503 });
    const cancel = vi.spyOn(response.body!, 'cancel');
    await probe(response).run();
    expect(cancel).toHaveBeenCalled();
  });

  it('servidor lento (timeout) não bloqueia: o navegador tenta, como antes da checagem', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(await probe(timeout).run()).toBeNull();
  });

  it('exceção de rede (DNS, conexão recusada) vira { network: true } sem vazar a causa', async () => {
    expect(await probe(new Error('getaddrinfo ENOTFOUND secret.internal')).run()).toEqual({ network: true });
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
    await beginLogin('github', d);
    const r = await exchangeAuthCode('code123', 'nonce-de-atacante', d);
    expect(r.ok).toBe(false);
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(d.setSecret).not.toHaveBeenCalled();
  });

  it('state correto: troca o code, guarda tokens e aplica licença', async () => {
    const d = deps();
    await beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const nonce = url.searchParams.get('app_state')!;
    const r = await exchangeAuthCode('code123', nonce, d);
    expect(r).toEqual({ ok: true });
    expect(d.setSecret).toHaveBeenCalledWith('auth:session', 's');
    expect(d.setSecret).toHaveBeenCalledWith('auth:refresh', 'r');
    expect(d.applyLicense).toHaveBeenCalledWith('jwt');
  });

  it('licença atrasada no servidor: guarda os tokens, não valida nada e pede a licença depois', async () => {
    const syncLicense = vi.fn();
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r' } })))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'account-a' } })));
    const d = deps({ fetchFn, syncLicense });
    await beginLogin('github', d);
    const nonce = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string).searchParams.get('app_state')!;

    expect(await exchangeAuthCode('code123', nonce, d)).toEqual({ ok: true });

    expect(d.setSecret).toHaveBeenCalledWith('auth:refresh', 'r');
    expect(d.bindAccount).toHaveBeenCalledWith('account-a', 's');
    expect(d.validateLicense).not.toHaveBeenCalled();
    expect(d.applyLicense).not.toHaveBeenCalled();
    expect(syncLicense).toHaveBeenCalledTimes(1);
  });

  it('licença presente mas vazia continua sendo resposta inválida', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: '' } })));
    const d = deps({ fetchFn });
    await beginLogin('github', d);
    const nonce = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string).searchParams.get('app_state')!;
    expect(await exchangeAuthCode('code123', nonce, d)).toEqual({ ok: false, error: 'exchange-invalid-response' });
    expect(d.setSecret).not.toHaveBeenCalled();
  });

  it('nonce é single-use: segundo deep link com o mesmo state → rejeita', async () => {
    const d = deps();
    await beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const nonce = url.searchParams.get('app_state')!;
    expect((await exchangeAuthCode('c1', nonce, d)).ok).toBe(true);
    expect((await exchangeAuthCode('c2', nonce, d)).ok).toBe(false);
  });

  it('falha ao persistir secret ou licença → falha FECHADO', async () => {
    const d = deps({ setSecret: vi.fn().mockReturnValue({ ok: false, error: 'keychain' }) });
    await beginLogin('github', d);
    const url = new URL((d.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    const r = await exchangeAuthCode('code123', url.searchParams.get('app_state')!, d);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('exchange-storage');
  });

  it('erro do backend não guarda nada', async () => {
    const d = deps({ fetchFn: vi.fn().mockResolvedValue(new Response('nope', { status: 400 })) });
    await beginLogin('github', d);
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
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    expect((await exchangeAuthCode('c', state, d)).ok).toBe(true);
    expect(d.bindAccount).toHaveBeenCalledWith('account-a', 's');
    expect(d.fetchFn).toHaveBeenLastCalledWith('https://api.test/v1/me', expect.objectContaining({ headers: { authorization: 'Bearer s' } }));
  });
  it('refuses an exchange completed after logout or a replacement login', async () => {
    let done!: (r: Response) => void;
    const d = deps({ fetchFn: vi.fn(() => new Promise<Response>(resolve => { done = resolve; })) });
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    const flight = exchangeAuthCode('c', state, d);
    resetPendingLogin();
    done(new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } })));
    expect((await flight).ok).toBe(false);
    expect(d.setSecret).not.toHaveBeenCalled();
    expect(d.applyLicense).not.toHaveBeenCalled();
  });
  it('preserves an accepted exchange when reopening login is rejected by preflight', async () => {
    let done!: (response: Response) => void;
    const fetchFn = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { done = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { id: 'account-a' } })));
    const d = deps({ fetchFn, probeLogin: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 503 }) });
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    const old = exchangeAuthCode('accepted-code', state, d);
    expect((await beginLogin('google', d)).ok).toBe(false);
    done(new Response(JSON.stringify({ ok: true, data: { session: 's', refresh: 'r', licenca: 'jwt' } })));
    expect(await old).toEqual({ ok: true });
    expect(d.bindAccount).toHaveBeenCalledWith('account-a', 's');
  });
  it('marks an old failure stale while a reopened login preflight is still pending', async () => {
    let exchangeDone!: (response: Response) => void; let probeDone!: (value: null) => void;
    const fetchFn = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { exchangeDone = resolve; }));
    const d = deps({ fetchFn, probeLogin: vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise(resolve => { probeDone = resolve; })) });
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    const old = exchangeAuthCode('old-code', state, d);
    const newer = beginLogin('google', d);
    exchangeDone(new Response('denied', { status: 403 }));
    expect(await old).toEqual({ ok: false, error: 'login superseded' });
    probeDone(null); expect((await newer).ok).toBe(true);
  });
  it.each(['http', 'network', 'json'])('ignores an old %s failure after a new login starts', async kind => {
    let resolve!: (response: Response) => void; let reject!: (error: Error) => void;
    const d = deps({ fetchFn: vi.fn(() => new Promise<Response>((yes, no) => { resolve = yes; reject = no; })) });
    await beginLogin('github', d);
    const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
    const old = exchangeAuthCode('old-code', state, d);
    await beginLogin('google', d);
    if (kind === 'network') reject(new Error('offline'));
    else resolve(kind === 'http' ? new Response('denied', { status: 403 }) : new Response('not json'));
    expect(await old).toEqual({ ok: false, error: 'login superseded' });
    expect(d.setSecret).not.toHaveBeenCalled();
    expect(d.bindAccount).not.toHaveBeenCalled();
  });
});


function identityStore() {
  const values = new Map<string, string>();
  return { values, getSecret: (key: string) => values.get(key) ?? null,
    hasSecret: (key: string) => values.has(key),
    hasCachedSecret: (key: string) => values.has(key),
    setInternalSecret: (key: string, value: string) => { values.set(key, value); return { ok: true }; } };
}
it('cached identity belongs to exactly one opaque session and never unlocks the vault in a query', () => {
  const store = identityStore();
  const read = vi.spyOn(store, 'getSecret');
  expect(getAuthenticatedAccountId(store)).toBeNull();
  expect(read).not.toHaveBeenCalled();
  store.setInternalSecret('auth:session', 'session-a');
  bindAuthenticatedAccount('account-a', 'session-a', store);
  expect(getAuthenticatedAccountId(store)).toBe('account-a');
  store.setInternalSecret('auth:session', 'session-b');
  expect(getAuthenticatedAccountId(store)).toBeNull();
});
it('restores an old session identity after network recovery, but never after logout', async () => {
  const store = identityStore();
  store.setInternalSecret('auth:session', 'session-a');
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
  await beginLogin('github', d);
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
  await beginLogin('github', d);
  const state = new URL(d.openExternal.mock.calls[0][0]).searchParams.get('app_state');
  const result = await exchangeAuthCode('code', state, d);
  expect(result.ok).toBe(false);
  expect(JSON.stringify([result, warn.mock.calls, error.mock.calls])).not.toContain(marker);
  warn.mockRestore(); error.mockRestore();
});

it('logout revokes Main access before deleting credentials and survives an offline backend', async () => {
  const steps: string[] = [];
  const secrets = new Map([['auth:session', 's'], ['auth:refresh', 'r']]);
  const result = await logoutAuthSession({ backendUrl: 'https://api.test',
    clearAccess: () => { steps.push('clear'); }, getSecret: key => secrets.get(key) ?? null,
    deleteSecret: key => { steps.push(key); secrets.delete(key); return { ok: true }; },
    fetchFn: vi.fn().mockRejectedValue(new Error('offline')) });
  expect(steps).toEqual(['clear', 'auth:session', 'auth:refresh']);
  expect(secrets.size).toBe(0); expect(result.ok).toBe(true);
});

it.each([
  ['the rejected pair is still stored', 'r', ['clear', 'auth:session', 'auth:refresh']],
  ['a newer login already replaced it', 'r-new', []],
])('a refused refresh is forgotten locally when %s', (_label, stored, expected) => {
  const steps: string[] = [];
  const secrets = new Map([['auth:session', 's'], ['auth:refresh', stored]]);
  discardRejectedSession('r', { clearAccess: () => { steps.push('clear'); }, getSecret: key => secrets.get(key) ?? null,
    deleteSecret: key => { steps.push(key); secrets.delete(key); return { ok: true }; } });
  expect(steps).toEqual(expected);
});

it('records why the app signed out, without credentials, in the Main trace', async () => {
  const events: Record<string, unknown>[] = [];
  const secrets = new Map([['auth:session', 'session-secret'], ['auth:refresh', 'refresh-secret']]);
  const store = { clearAccess: () => {}, getSecret: (key: string) => secrets.get(key) ?? null,
    deleteSecret: (key: string) => { secrets.delete(key); return { ok: true }; }, trace: (event: Record<string, unknown>) => { events.push(event); } };
  discardRejectedSession('other-refresh', store);
  discardRejectedSession('refresh-secret', store);
  secrets.set('auth:session', 'session-secret');
  await logoutAuthSession({ ...store, backendUrl: 'https://api.test', fetchFn: vi.fn().mockResolvedValue(new Response(null)) });
  expect(events).toEqual([{ kind: 'signed-out', reason: 'refresh-rejected' }, { kind: 'signed-out', reason: 'user-logout' }]);
  expect(JSON.stringify(events)).not.toMatch(/secret/);
});

it('logout revokes the unsaved pair apiFetch was using; logout and a refused refresh both forget it', async () => {
  const steps: string[] = [];
  const secrets = new Map([['auth:session', 'spent-session'], ['auth:refresh', 'spent-refresh']]);
  const store = { clearAccess: () => { steps.push('clear'); }, getSecret: (key: string) => secrets.get(key) ?? null,
    deleteSecret: (key: string) => { secrets.delete(key); return { ok: true }; },
    dropUnsavedPairs: () => { steps.push('drop'); return 'memory-session'; } };
  const fetchFn = vi.fn().mockResolvedValue(new Response(null));

  await logoutAuthSession({ ...store, backendUrl: 'https://api.test', fetchFn });

  expect((fetchFn.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers.authorization).toBe('Bearer memory-session');
  // Read before clearAccess starts a new login generation.
  expect(steps).toEqual(['drop', 'clear']);
  steps.length = 0;
  secrets.set('auth:refresh', 'r');
  discardRejectedSession('r', store);
  expect(steps).toEqual(['drop', 'clear']);
});
