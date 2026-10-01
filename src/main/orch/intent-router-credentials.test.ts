import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import * as providerConfig from '../persistence/provider-config-store';
import { answerDirectQuestion, routeIntent } from './intent-router';

// Hermeticidade: a máquina do operador tem TYPESAFE_API_KEY no shell e o
// autopilot Jev liga por default — sem o mock, a triagem real externa decide
// o resultado. Os caminhos do Jev têm suíte própria (intent-router-jev.test.ts).
vi.mock('./intent-router-jev', () => ({
  routeWithJev: async () => null,
}));

const credentials = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  launcher: new Map<string, string>(),
  indexed: new Set<string>(),
  readVault: vi.fn<(id: string) => string | null>(),
}));

vi.mock('../persistence/secrets-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../persistence/secrets-store')>(),
  getKey: credentials.readVault,
  hasSecret: (id: string) => credentials.vault.has(id) || credentials.indexed.has(id),
}));

vi.mock('../adapters/launcher-provider-manager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/launcher-provider-manager')>(),
  loadLauncherProviderKey: (id: string) => credentials.launcher.get(id) ?? null,
}));

// Load the real adapter contracts without starting registry discovery/watchers.
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../adapters/adapter-registry')>(),
  getAdapter: (id: string) =>
    BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw))
      .find((adapter) => adapter.id === id) ?? null,
}));

const ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ZAI_API_KEY',
  'DASHSCOPE_API_KEY',
] as const;

const PROVIDERS = [
  {
    provider: 'deepseek',
    env: 'DEEPSEEK_API_KEY',
    endpoint: 'https://api.deepseek.com/chat/completions',
    header: 'authorization',
    value: 'Bearer test-runtime-key',
  },
  {
    provider: 'glm',
    env: 'ZAI_API_KEY',
    endpoint: 'https://api.z.ai/api/anthropic/v1/messages',
    header: 'x-api-key',
    value: 'test-runtime-key',
  },
  {
    provider: 'qwen',
    env: 'DASHSCOPE_API_KEY',
    endpoint: 'https://dashscope.aliyuncs.com/api/anthropic/v1/messages',
    header: 'x-api-key',
    value: 'test-runtime-key',
  },
] as const;

beforeEach(() => {
  credentials.vault.clear();
  credentials.launcher.clear();
  credentials.indexed.clear();
  credentials.readVault.mockReset().mockImplementation(
    (id) => credentials.vault.get(id) ?? null,
  );
  for (const name of ENV_KEYS) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each(['classification', 'direct answer'] as const)(
  'router runtime credentials: %s',
  (operation) => {
    const content = operation === 'classification'
      ? '{"kind":"mission-work","skills":[]}'
      : '2';
    const expected = operation === 'classification'
      ? { kind: 'mission-work', skills: [] }
      : '2';
    const invoke = (fetchImpl: typeof fetch, timeoutMs?: number) =>
      operation === 'classification'
        ? routeIntent('melhore o desempenho do site', { fetchImpl, timeoutMs })
        : answerDirectQuestion('quanto é 1+1?', { fetchImpl, timeoutMs });
    const response = (provider = 'deepseek') => new Response(JSON.stringify(
      provider === 'deepseek'
        ? { choices: [{ message: { content } }] }
        : { content: [{ type: 'text', text: content }] },
    ));

    it.each(PROVIDERS)('uses the vault credential for $provider without a launcher entry', async ({ provider, endpoint, header, value }) => {
      credentials.vault.set(provider, 'test-runtime-key');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(provider));

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(endpoint);
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get(header)).toBe(value);
    });

    it.each([
      ...PROVIDERS,
      { ...PROVIDERS[1], env: 'ANTHROPIC_AUTH_TOKEN' },
    ])('uses $env without a vault or launcher entry', async ({ provider, env, endpoint, header, value }) => {
      vi.stubEnv(env, ' test-runtime-key ');
      if (env === 'ANTHROPIC_AUTH_TOKEN') {
        // O token Anthropic genérico só vale como credencial do glm quando o
        // BASE_URL do env já aponta para api.z.ai (host gate, F-236 rework).
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic');
      }
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(provider));

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(endpoint);
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get(header)).toBe(value);
    });

    it('ignores a bare ANTHROPIC_AUTH_TOKEN with no matching BASE_URL', async () => {
      // Sem ANTHROPIC_BASE_URL apontando para o host do provider, o token
      // genérico não é credencial de nenhum host-Claude da cadeia — nenhum
      // fetch sai e o router cai no fallback sem key.
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', ' test-runtime-key ');
      vi.stubEnv('ANTHROPIC_BASE_URL', '');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());

      expect(await invoke(fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('prefers the vault over launcher and environment credentials', async () => {
      credentials.vault.set('deepseek', 'test-vault-key');
      credentials.launcher.set('deepseek', 'test-launcher-key');
      vi.stubEnv('DEEPSEEK_API_KEY', 'test-env-key');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization'))
        .toBe('Bearer test-vault-key');
    });

    it('prefers launcher over environment credentials', async () => {
      credentials.launcher.set('deepseek', 'test-launcher-key');
      vi.stubEnv('DEEPSEEK_API_KEY', 'test-env-key');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization'))
        .toBe('Bearer test-launcher-key');
    });

    it('skips disabled providers before decrypting or sending their credentials', async () => {
      credentials.vault.set('deepseek', 'test-disabled-key');
      credentials.launcher.set('deepseek', 'test-disabled-launcher-key');
      credentials.vault.set('glm', 'test-enabled-key');
      vi.spyOn(providerConfig, 'isProviderEnabled').mockImplementation((id) => id !== 'deepseek');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response('glm'));

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe('https://api.z.ai/api/anthropic/v1/messages');
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('x-api-key'))
        .toBe('test-enabled-key');
      expect(credentials.readVault).not.toHaveBeenCalledWith('deepseek');
    });

    it('makes no request when credentials are missing, blank, or unavailable in the vault', async () => {
      credentials.indexed.add('deepseek');
      vi.stubEnv('DASHSCOPE_API_KEY', '  ');
      const fetchImpl = vi.fn<typeof fetch>();

      expect(await invoke(fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('preserves provider order and each fallback credential after an HTTP failure', async () => {
      credentials.vault.set('deepseek', 'test-first-key');
      vi.stubEnv('ZAI_API_KEY', 'test-second-key');
      credentials.launcher.set('qwen', 'test-third-key');
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(response('qwen'));

      expect(await invoke(fetchImpl)).toEqual(expected);
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
        'https://api.deepseek.com/chat/completions',
        'https://api.z.ai/api/anthropic/v1/messages',
        'https://dashscope.aliyuncs.com/api/anthropic/v1/messages',
      ]);
      expect(fetchImpl.mock.calls.map(([, init]) => {
        const headers = new Headers(init?.headers);
        return headers.get('authorization') ?? headers.get('x-api-key');
      })).toEqual(['Bearer test-first-key', 'test-second-key', 'test-third-key']);
    });

    it('aborts a timed-out provider and continues with the next configured provider', async () => {
      vi.useFakeTimers();
      credentials.vault.set('deepseek', 'test-first-key');
      credentials.vault.set('glm', 'test-second-key');
      const fetchImpl = vi.fn<typeof fetch>()
        .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }))
        .mockResolvedValueOnce(response('glm'));

      const result = invoke(fetchImpl, 10);
      await vi.advanceTimersByTimeAsync(10);

      expect(await result).toEqual(expected);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fetchImpl.mock.calls[1][0]).toBe('https://api.z.ai/api/anthropic/v1/messages');
      expect(vi.getTimerCount()).toBe(0);
    });
  },
);
