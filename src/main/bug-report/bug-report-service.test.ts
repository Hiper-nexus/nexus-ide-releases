import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBugReportService,
  type BugReportServiceDeps,
} from './bug-report-service';
import { bugReportPayloadSchema, type BugReportPayload } from '../../shared/bug-report';

const traceLine = (event: Record<string, unknown>): string => JSON.stringify(event);

/** Segredo montado em runtime: nenhum literal com formato de credencial no repo. */
const SESSION_TOKEN = `s${'e'}ssao${'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY'.repeat(2)}`;

const baseRequest = {
  title: 'O terminal trava ao colar',
  description: 'Ao colar um texto longo o pane congela por alguns segundos.',
  category: 'terminal' as const,
  impact: 'annoying' as const,
  includeDiagnostics: false,
};

type ApiMock = ReturnType<typeof vi.fn<BugReportServiceDeps['api']>>;

function setup(overrides: Partial<BugReportServiceDeps> = {}) {
  let trace = traceLine({ kind: 'main-boot', at: 1_000 });
  const api: ApiMock = vi.fn<BugReportServiceDeps['api']>(async () => ({
    status: 201,
    json: { ok: true, data: { id: 'BR-0001', status: 'new' } },
  }));
  const listAgentSessions = vi.fn(() => [
    { paneId: 'p1', adapterId: 'claude', model: 'opus-5', missionId: 'm1' },
  ]);
  const deps: BugReportServiceDeps = {
    api,
    now: () => 5_000,
    redaction: { homeDir: '/Users/ana' },
    diagnostics: {
      appVersion: '0.76.161',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '27.2.0',
      listAgentSessions,
      readTraceTail: async () => trace,
    },
    ...overrides,
  };
  const service = createBugReportService(() => deps);
  return {
    service,
    api,
    listAgentSessions,
    setTrace(next: string) {
      trace = next;
    },
  };
}

function lastBody(api: ApiMock): BugReportPayload {
  const call = api.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call as unknown as [string, { body: BugReportPayload }])[1].body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('preview', () => {
  it('builds a contract-valid payload without diagnostics when consent is off', async () => {
    const { service, listAgentSessions } = setup();
    const result = await service.preview(baseRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bugReportPayloadSchema.safeParse(result.payload).success).toBe(true);
    expect(result.payload.consent).toEqual({ diagnostics: false });
    expect(result.payload.diagnostics).toBeUndefined();
    expect(result.payload.context).toBeUndefined();
    expect(result.payload.app).toEqual({
      version: '0.76.161',
      platform: 'darwin',
      arch: 'arm64',
      osVersion: '27.2.0',
    });
    // Sem consentimento o Main nem consulta a frota.
    expect(listAgentSessions).not.toHaveBeenCalled();
  });

  it('adds context and trace diagnostics only when consent is on', async () => {
    const { service, setTrace } = setup();
    setTrace(
      [
        traceLine({ kind: 'main-boot', at: 1_000 }),
        traceLine({ kind: 'agent-pty-exit', at: 2_000, code: 1, prompt: 'SENTINELA-PROMPT' }),
      ].join('\n'),
    );
    const result = await service.preview({ ...baseRequest, includeDiagnostics: true, activePaneId: 'p1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.consent).toEqual({ diagnostics: true });
    expect(result.payload.context).toEqual({
      adapter: 'claude',
      model: 'opus-5',
      paneCount: 1,
      missionActive: true,
    });
    expect(result.payload.diagnostics?.events).toEqual([
      { t: 1_000, kind: 'main-boot' },
      { t: 2_000, kind: 'agent-pty-exit', code: '1' },
    ]);
    expect(JSON.stringify(result.payload)).not.toContain('SENTINELA');
    expect(JSON.stringify(result.payload)).not.toContain('p1');
  });

  it('redacts typed text before it can be shown or sent', async () => {
    const { service } = setup();
    const result = await service.preview({
      ...baseRequest,
      title: 'Falha ao entrar com ana@exemplo.com',
      description: `O erro aparece em /Users/ana/projeto/log.txt com a chave ${SESSION_TOKEN}`,
      steps: 'Rodar com API_KEY=abc123def456ghi789',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('ana@exemplo.com');
    expect(serialized).not.toContain('/Users/ana');
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain('abc123def456ghi789');
    expect(result.payload.description).toContain('~/projeto/log.txt');
  });

  it('refuses invalid payloads without touching the diagnostics sources', async () => {
    const { service, listAgentSessions, api } = setup();
    const bad: unknown[] = [
      null,
      'texto',
      {},
      { ...baseRequest, title: 'abc' },
      { ...baseRequest, category: 'segurança' },
      { ...baseRequest, includeDiagnostics: 'sim' },
      // O renderer não pode contrabandear diagnóstico nem credencial.
      { ...baseRequest, diagnostics: { events: [], errors: [] } },
      { ...baseRequest, token: SESSION_TOKEN },
      { ...baseRequest, app: { version: '9.9.9' } },
    ];
    for (const candidate of bad) {
      const result = await service.preview(candidate);
      expect(result).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(listAgentSessions).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it('refuses a report whose title or description collapses after redaction', async () => {
    const { service } = setup();
    const result = await service.preview({ ...baseRequest, title: '/Users/ab/x' });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect((result as { message: string }).message).toMatch(/curto demais/);
  });
});

describe('submit', () => {
  it('POSTs the redacted payload to the v1 endpoint with a short timeout and no redirects', async () => {
    const { service, api } = setup();
    const result = await service.submit({ ...baseRequest, includeDiagnostics: true });
    expect(result).toEqual({ ok: true, id: 'BR-0001' });
    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = api.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/v1/bug-reports');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(bugReportPayloadSchema.safeParse(init.body).success).toBe(true);
  });

  it('sends no diagnostics and no context when consent is off', async () => {
    const { service, api } = setup();
    await service.submit(baseRequest);
    const body = lastBody(api);
    expect(body.consent).toEqual({ diagnostics: false });
    expect(body).not.toHaveProperty('diagnostics');
    expect(body).not.toHaveProperty('context');
  });

  it('sends exactly what the preview showed, even if the trace moved on', async () => {
    const { service, api, setTrace } = setup();
    const request = { ...baseRequest, includeDiagnostics: true, activePaneId: 'p1' };
    const previewed = await service.preview(request);
    expect(previewed.ok).toBe(true);
    if (!previewed.ok) return;

    setTrace(
      [
        traceLine({ kind: 'main-boot', at: 1_000 }),
        traceLine({ kind: 'novo-evento-depois-da-previa', at: 9_000 }),
      ].join('\n'),
    );
    await service.submit(request);
    expect(lastBody(api)).toEqual(previewed.payload);
  });

  it('returns a digest of the exact body with the preview', async () => {
    const { service } = setup();
    const previewed = await service.preview(baseRequest);
    expect(previewed.ok).toBe(true);
    if (!previewed.ok) return;
    expect(previewed.digest).toMatch(/^[0-9a-f]{64}$/);
    const again = await service.preview(baseRequest);
    expect(again.ok && again.digest).toBe(previewed.digest);
    const other = await service.preview({ ...baseRequest, title: 'Outro título para o relato' });
    expect(other.ok && other.digest).not.toBe(previewed.digest);
  });

  it('sends when the digest the person saw matches the body', async () => {
    const { service, api } = setup();
    const previewed = await service.preview(baseRequest);
    if (!previewed.ok) throw new Error('preview failed');
    expect(await service.submit({ ...baseRequest, previewDigest: previewed.digest })).toEqual({
      ok: true,
      id: 'BR-0001',
    });
    expect(lastBody(api)).toEqual(previewed.payload);
  });

  it('refuses to send a body that differs from the one the person previewed', async () => {
    let now = 5_000;
    const { service, api, setTrace } = setup({ now: () => now });
    const request = { ...baseRequest, includeDiagnostics: true };
    const previewed = await service.preview(request);
    if (!previewed.ok) throw new Error('preview failed');
    // A prévia expirou e o trace andou: o corpo reconstruído seria outro.
    setTrace(traceLine({ kind: 'evento-novo', at: 8_000 }));
    now += 60 * 60 * 1000;
    const result = await service.submit({ ...request, previewDigest: previewed.digest });
    expect(result).toMatchObject({ ok: false, code: 'stale-preview' });
    expect((result as { message: string }).message).toMatch(/prévia/);
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects a malformed digest', async () => {
    const { service, api } = setup();
    expect(await service.submit({ ...baseRequest, previewDigest: 'nao-e-hash' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('rebuilds the payload when the request changed after the preview', async () => {
    const { service, api } = setup();
    await service.preview(baseRequest);
    await service.submit({ ...baseRequest, title: 'Outro título depois da prévia' });
    expect(lastBody(api).title).toBe('Outro título depois da prévia');
  });

  it('does not reuse a preview after it expired', async () => {
    let now = 5_000;
    const { service, api, setTrace } = setup({ now: () => now });
    const request = { ...baseRequest, includeDiagnostics: true };
    await service.preview(request);
    setTrace(traceLine({ kind: 'evento-novo', at: 8_000 }));
    now += 60 * 60 * 1000;
    await service.submit(request);
    expect(lastBody(api).diagnostics?.events).toEqual([{ t: 8_000, kind: 'evento-novo' }]);
  });

  it('refuses invalid payloads without any network call', async () => {
    const { service, api } = setup();
    const result = await service.submit({ ...baseRequest, includeDiagnostics: undefined });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(api).not.toHaveBeenCalled();
  });

  it('refuses to send a body above the contract size', async () => {
    const { service, api } = setup({ maxBodyBytes: 100 });
    const result = await service.submit(baseRequest);
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect(api).not.toHaveBeenCalled();
  });

  it('allows only one submission at a time', async () => {
    let release: (value: { status: number; json: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; json: unknown }>((resolve) => {
      release = resolve;
    });
    const { service } = setup({ api: vi.fn(() => pending) as unknown as BugReportServiceDeps['api'] });
    const first = service.submit(baseRequest);
    // Dá a vez ao primeiro envio antes de tentar o segundo.
    await Promise.resolve();
    await Promise.resolve();
    const second = await service.submit(baseRequest);
    expect(second).toMatchObject({ ok: false, code: 'busy' });
    release({ status: 201, json: { ok: true, data: { id: 'BR-9', status: 'new' } } });
    expect(await first).toEqual({ ok: true, id: 'BR-9' });
  });

  it('limits how many sends one process attempts in a short window', async () => {
    let now = 1_000;
    const { service, api } = setup({ now: () => now });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      now += 1_000;
      expect(await service.submit(baseRequest)).toMatchObject({ ok: true });
    }
    now += 1_000;
    const blocked = await service.submit(baseRequest);
    expect(blocked).toMatchObject({ ok: false, code: 'rate-limited' });
    expect((blocked as { message: string }).message).toMatch(/Aguarde/);
    expect(api).toHaveBeenCalledTimes(10);
    // Passada a janela, volta a enviar.
    now += 11 * 60 * 1000;
    expect(await service.submit(baseRequest)).toMatchObject({ ok: true });
  });

  it('can send again after a failure', async () => {
    const { service, api } = setup();
    api.mockResolvedValueOnce({ status: 0, json: null });
    expect(await service.submit(baseRequest)).toMatchObject({ ok: false, code: 'network' });
    expect(await service.submit(baseRequest)).toEqual({ ok: true, id: 'BR-0001' });
  });
});

describe('error mapping', () => {
  async function failWith(status: number, json: unknown) {
    const { service, api } = setup();
    api.mockResolvedValueOnce({ status, json });
    return service.submit(baseRequest);
  }

  it('401 asks the person to sign in again', async () => {
    const result = await failWith(401, null);
    expect(result).toMatchObject({ ok: false, code: 'no-session' });
    expect((result as { message: string }).message).toMatch(/entrar na sua conta/i);
  });

  it('413 explains the report is too large', async () => {
    const result = await failWith(413, { ok: false, error: 'payload too large' });
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect((result as { message: string }).message).toMatch(/grande demais/);
  });

  it('400 shows the server message', async () => {
    const result = await failWith(400, { ok: false, error: 'título repetido' });
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect((result as { message: string }).message).toContain('título repetido');
  });

  it('429 shows the server message verbatim and falls back to the hourly limit', async () => {
    const withMessage = await failWith(429, { ok: false, error: 'Limite de 5 relatos por hora atingido.' });
    expect(withMessage).toMatchObject({ ok: false, code: 'rate-limited' });
    expect((withMessage as { message: string }).message).toBe('Limite de 5 relatos por hora atingido.');
    const without = await failWith(429, null);
    expect((without as { message: string }).message).toMatch(/5 relatos por hora/);
  });

  it('5xx and network failures have their own messages', async () => {
    expect(await failWith(503, null)).toMatchObject({ ok: false, code: 'server' });
    const network = await failWith(0, null);
    expect(network).toMatchObject({ ok: false, code: 'network' });
    expect((network as { message: string }).message).toMatch(/conexão/);
  });

  it('a 2xx with an unexpected body is not reported as success', async () => {
    expect(await failWith(201, { ok: true, data: {} })).toMatchObject({ ok: false, code: 'invalid-response' });
    expect(await failWith(201, 'ok')).toMatchObject({ ok: false, code: 'invalid-response' });
    expect(await failWith(201, { ok: false })).toMatchObject({ ok: false, code: 'invalid-response' });
  });

  it('an unexpected status falls back to a generic message', async () => {
    expect(await failWith(418, null)).toMatchObject({ ok: false, code: 'server' });
  });

  it('keeps the redacted payload on failure so the person can copy the report', async () => {
    const { service, api } = setup();
    api.mockResolvedValueOnce({ status: 0, json: null });
    const result = await service.submit({
      ...baseRequest,
      description: 'Falha com ana@exemplo.com ao colar um texto longo no terminal.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.payload?.title).toBe(baseRequest.title);
    expect(JSON.stringify(result.payload)).not.toContain('ana@exemplo.com');
  });

  it('does not attach a payload when the request itself was invalid', async () => {
    const { service } = setup();
    const result = await service.submit({ nope: true });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(result).not.toHaveProperty('payload');
  });

  it('never leaks a credential echoed by the server into the result', async () => {
    const secret = `Bearer ${SESSION_TOKEN}`;
    for (const status of [400, 401, 429, 500]) {
      const result = await failWith(status, {
        ok: false,
        error: `rejeitado: ${secret} e ${SESSION_TOKEN}`,
      });
      expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN);
    }
  });

  it('caps a hostile oversized server message before redacting it (no main-thread stall)', async () => {
    const started = performance.now();
    const result = await failWith(400, { ok: false, error: `${'aaaa '.repeat(13_000)}` });
    expect(performance.now() - started).toBeLessThan(750);
    expect((result as { message: string }).message.length).toBeLessThanOrEqual(400);
    const dense = await failWith(400, { ok: false, error: 'a'.repeat(64 * 1024) });
    expect(performance.now() - started).toBeLessThan(1500);
    expect((dense as { message: string }).message.length).toBeLessThanOrEqual(400);
  });

  it('strips control characters and caps the length of server messages', async () => {
    const result = await failWith(400, {
      ok: false,
      error: `linha\u0000\u001b[31m\n${'palavra '.repeat(200)}`,
    });
    const message = (result as { message: string }).message;
    // eslint-disable-next-line no-control-regex -- a asserção procura justamente caracteres de controle
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message.length).toBeLessThanOrEqual(400);
  });
});

describe('logging', () => {
  it('writes nothing to the console on success or failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { service, api } = setup();
    await service.submit({ ...baseRequest, includeDiagnostics: true });
    api.mockResolvedValueOnce({ status: 500, json: { ok: false, error: `x ${SESSION_TOKEN}` } });
    await service.submit(baseRequest);
    api.mockRejectedValueOnce(new Error(`falha com ${SESSION_TOKEN}`));
    await service.submit(baseRequest);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('maps an unexpected throw from the transport to a network failure without echoing it', async () => {
    const { service, api } = setup();
    api.mockRejectedValueOnce(new Error(`falha com ${SESSION_TOKEN}`));
    const result = await service.submit(baseRequest);
    expect(result).toMatchObject({ ok: false, code: 'network' });
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN);
  });
});
