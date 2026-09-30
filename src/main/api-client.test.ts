import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

function deps(over: Record<string, unknown> = {}) {
  const store: Record<string, string> = {
    'auth:session': 'sess-1',
    'auth:refresh': 'ref-1',
  };
  return {
    backendUrl: 'https://api.test',
    fetchFn: vi.fn(),
    getSecret: (key: string) => store[key] ?? null,
    setSecret: (key: string, value: string) => {
      store[key] = value;
      return { ok: true };
    },
    store,
    ...over,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiFetch', () => {
  it('anexa o Bearer da sessao e devolve o json', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockResolvedValue(json({ ok: true, data: 1 }));

    const result = await apiFetch('/v1/team', {}, d as never);

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true, data: 1 });
    const call = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.test/v1/team');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer sess-1');
  });

  it('401 roda o refresh, guarda o par novo e repete uma vez', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(json({ ok: false }, 401))
      .mockResolvedValueOnce(json({ ok: true, data: { session: 's2', refresh: 'r2' } }))
      .mockResolvedValueOnce(json({ ok: true, data: 42 }));

    const result = await apiFetch('/v1/team', {}, d as never);

    expect(result.status).toBe(200);
    expect(d.store['auth:session']).toBe('s2');
    expect(d.store['auth:refresh']).toBe('r2');
    const refreshCall = (d.fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(refreshCall[0]).toBe('https://api.test/v1/auth/refresh');
  });

  it('refresh tambem falha devolve 401 sem loop', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(json({ ok: false }, 401))
      .mockResolvedValueOnce(json({ ok: false }, 401));

    const result = await apiFetch('/v1/team', {}, d as never);

    expect(result.status).toBe(401);
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('sem sessao no Keychain retorna 401 sintetico sem rede', async () => {
    const d = deps({ getSecret: () => null });

    const result = await apiFetch('/v1/team', {}, d as never);

    expect(result.status).toBe(401);
    expect((d.fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('rede caiu retorna status 0 sem lancar', async () => {
    const d = deps();
    (d.fetchFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    const result = await apiFetch('/v1/team', {}, d as never);

    expect(result).toEqual({ status: 0, json: null });
  });

  it('aplica timeout e rejeita resposta acima do budget', async () => {
    const d = deps();
    let sawSignal = false;
    (d.fetchFn as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, init: RequestInit) => {
        sawSignal = init.signal instanceof AbortSignal;
        return json({ payload: 'x'.repeat(200) });
      },
    );

    const result = await apiFetch(
      '/v1/cron/test',
      { timeoutMs: 1_000, maxResponseBytes: 64 },
      d as never,
    );

    expect(sawSignal).toBe(true);
    expect(result).toEqual({ status: 0, json: null });
  });

  it('compõe o cancelamento do caller com o timeout da requisição', async () => {
    const release = deferred();
    const observed: { signal?: AbortSignal } = {};
    const d = deps({
      fetchFn: vi.fn(async (_url: string, init: RequestInit) => {
        observed.signal = init.signal as AbortSignal;
        await release.promise;
        if (observed.signal.aborted) throw new Error('aborted');
        return json({ ok: true });
      }),
    });
    const controller = new AbortController();

    const pending = apiFetch(
      '/v1/cron/schedules',
      { timeoutMs: 1_000, signal: controller.signal },
      d as never,
    );
    await Promise.resolve();
    controller.abort();
    release.resolve();

    await expect(pending).resolves.toEqual({ status: 0, json: null });
    expect(observed.signal?.aborted).toBe(true);
  });

  it('faz uma única rotação quando requests concorrentes recebem 401', async () => {
    const d = deps();
    let refreshCalls = 0;
    (d.fetchFn as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url.endsWith('/v1/auth/refresh')) {
          refreshCalls += 1;
          await Promise.resolve();
          return json({ ok: true, data: { session: 's2', refresh: 'r2' } });
        }
        const session = d.store['auth:session'];
        return session === 's2'
          ? json({ ok: true, data: 42 })
          : json({ ok: false }, 401);
      },
    );

    const [first, second] = await Promise.all([
      apiFetch('/v1/cron/a', {}, d as never),
      apiFetch('/v1/cron/b', {}, d as never),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(d.store['auth:refresh']).toBe('r2');
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}


it('applies licenca returned by refresh after storing the new session', async () => {
  const applied: string[] = [];
  const d = deps({ applyLicense: (jwt: string) => { applied.push(jwt); return { ok: true }; } });
  d.fetchFn.mockResolvedValueOnce(json({}, 401))
    .mockResolvedValueOnce(json({ ok: true, data: { session: 's2', refresh: 'r2', licenca: 'suspended-jwt' } }))
    .mockResolvedValueOnce(json({ ok: true }));
  await apiFetch('/v1/team', {}, d);
  expect(applied).toEqual(['suspended-jwt']);
});
it.each(['logout', 'switch'])('ignores refresh finishing after %s', async kind => {
  const release = deferred<Response>();
  const d = deps();
  d.fetchFn.mockResolvedValueOnce(json({}, 401)).mockImplementationOnce(() => release.promise);
  const flight = apiFetch('/v1/team', {}, d);
  await vi.waitFor(() => expect(d.fetchFn).toHaveBeenCalledTimes(2));
  d.store['auth:session'] = kind === 'logout' ? '' : 'other-session';
  d.store['auth:refresh'] = kind === 'logout' ? '' : 'other-refresh';
  release.resolve(json({ ok: true, data: { session: 'stale', refresh: 'stale-r', licenca: 'stale-jwt' } }));
  await flight;
  expect(d.store['auth:session']).toBe(kind === 'logout' ? '' : 'other-session');
});

it('does not return data from an authenticated request after session replacement', async () => {
  const response = deferred<Response>();
  const d = deps({ fetchFn: vi.fn(() => response.promise) });
  const flight = apiFetch('/v1/me', {}, d);
  d.store['auth:session'] = 'different-session';
  response.resolve(json({ ok: true, data: { id: 'old-account' } }));
  expect((await flight).status).toBe(401);
});
