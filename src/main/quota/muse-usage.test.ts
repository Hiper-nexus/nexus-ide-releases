import { describe, expect, it, vi } from 'vitest';
import {
  parseMuseSubscriptionWindows,
  probeMuseUsageWindows,
  resolveMuseLoginCredential,
} from './muse-usage';

const NOW = 1_789_000_000_000;

const SNAPSHOT = {
  subscription: {
    tier: 'pro',
    weekly: { resets_at: '1789344000', used_percent: '12.5' },
    window: { resets_at: '1789078632', used_percent: '34', window_duration_mins: '300' },
  },
};

function sse(...events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

describe('parseMuseSubscriptionWindows', () => {
  it('ignora o frame placeholder e lê janela atual + semanal do snapshot real', () => {
    const text = sse(
      { subscription: { window: {} } },
      { type: 'response.created', response: { id: 'resp_1' } },
      SNAPSHOT,
    );
    const windows = parseMuseSubscriptionWindows(text, NOW);
    expect(windows).toHaveLength(2);
    const hours = windows.find((w) => w.kind === 'hours');
    const weekly = windows.find((w) => w.kind === 'weekly');
    expect(hours?.label).toBe('5 Horas');
    expect(hours?.usedRatio).toBeCloseTo(0.34, 5);
    expect(hours?.resetsAt).toBe(1_789_078_632_000);
    expect(weekly?.label).toBe('Semanal');
    expect(weekly?.usedRatio).toBeCloseTo(0.125, 5);
    expect(weekly?.resetsAt).toBe(1_789_344_000_000);
    expect(hours?.source).toBe('provider-api');
  });

  it('aceita percentuais numéricos, limita a 100% e descarta lixo', () => {
    const text = sse({
      subscription: {
        window: { used_percent: 140, window_duration_mins: 300 },
        weekly: { used_percent: 'not-a-number' },
      },
    });
    const windows = parseMuseSubscriptionWindows(text, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0].usedRatio).toBe(1);
    expect(parseMuseSubscriptionWindows('data: [DONE]\n\nsem json', NOW)).toEqual([]);
    expect(parseMuseSubscriptionWindows('', NOW)).toEqual([]);
  });
});

describe('probeMuseUsageWindows', () => {
  it('sonda POST /v1/responses em stream com Bearer e devolve as janelas', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => sse(SNAPSHOT),
    }));
    const probe = await probeMuseUsageWindows('meta-test-key', { fetchImpl, now: NOW });
    expect(probe.windows).toHaveLength(2);
    expect(probe.authFailed).toBeFalsy();
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method?: string; headers?: Record<string, string>; body?: string }];
    expect(url).toBe('https://api.meta.ai/v1/responses');
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer ' + 'meta-test-key');
    const body = JSON.parse(init.body ?? '{}');
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(16);
    expect(body.model).toBe('muse-spark-1.3');
  });

  it('401 vira authFailed; chave vazia não chama a rede', async () => {
    const fetch401 = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    }));
    const denied = await probeMuseUsageWindows('dead-key', { fetchImpl: fetch401, now: NOW });
    expect(denied).toEqual({ windows: null, authFailed: true });

    const spy = vi.fn(async () => { throw new Error('rede não devia ser chamada'); });
    const empty = await probeMuseUsageWindows('  ', { fetchImpl: spy, now: NOW });
    expect(empty.windows).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('resolveMuseLoginCredential', () => {
  // Home inexistente: o modelo da sonda nunca lê o settings.json real da máquina.
  const NO_HOME = '/nonexistent-muse-home';
  const AUTH_JSON = JSON.stringify({
    providers: { meta: { storage: 'keychain', mechanism: 'oauth' } },
  });

  it('prefere META_API_KEY do ambiente e ignora valor com espaço', () => {
    const cred = resolveMuseLoginCredential({
      home: NO_HOME,
      env: { META_API_KEY: 'env-key-123' },
      readAuthFile: () => null,
      readPlatformSecret: () => null,
    });
    expect(cred?.apiKey).toBe('env-key-123');
    expect(cred?.model).toBe('muse-spark-1.3');
    expect(resolveMuseLoginCredential({
      home: NO_HOME,
      env: { META_API_KEY: 'two words' },
      readAuthFile: () => null,
      readPlatformSecret: () => null,
    })).toBeNull();
  });

  it('lê providers.meta.api_key do auth.json quando o storage é arquivo', () => {
    const blob = JSON.stringify({ providers: { meta: { api_key: 'file-key-456' } } });
    const cred = resolveMuseLoginCredential({
      home: NO_HOME,
      env: {},
      readAuthFile: () => blob,
      readPlatformSecret: () => null,
    });
    expect(cred?.apiKey).toBe('file-key-456');
  });

  it('storage keychain: extrai api_key do payload JSON do cofre, sem vazar o resto', () => {
    const seen: string[] = [];
    const cred = resolveMuseLoginCredential({
      home: NO_HOME,
      env: {},
      readAuthFile: () => AUTH_JSON,
      readPlatformSecret: (account) => {
        seen.push(account);
        return JSON.stringify({ api_key: 'kc-key-789', access_token: 'short-lived' });
      },
    });
    expect(seen).toEqual(['meta']);
    expect(cred?.apiKey).toBe('kc-key-789');
  });

  it('sem nenhuma fonte devolve null', () => {
    expect(resolveMuseLoginCredential({
      home: NO_HOME,
      env: {},
      readAuthFile: () => null,
      readPlatformSecret: () => null,
    })).toBeNull();
  });
});
